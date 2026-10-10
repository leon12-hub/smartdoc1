import { createReadStream } from "node:fs";
import { db } from "../../prisma/db.js";
import { HttpError } from "../../utils/httpError.js";
import { resolveStoredUpload } from "../../utils/uploadStorage.js";
import { createOAuthClient } from "./googleConfig.js";
import {
  decryptRefreshToken,
  encryptRefreshToken,
  getConnectedDriveClient,
} from "./googleToken.service.js";

const googleFolderMimeType = "application/vnd.google-apps.folder";
type DriveSyncResult = Awaited<ReturnType<typeof syncGuestDocumentToDriveOnce>>;
const driveSyncInFlight = new Map<string, Promise<DriveSyncResult>>();

export async function syncGuestDocumentToDrive(
  anonymousSessionId: string,
  documentId: string,
  folderId?: unknown,
): Promise<DriveSyncResult> {
  const existing = driveSyncInFlight.get(documentId);
  if (existing) return existing;
  const operation = syncGuestDocumentToDriveOnce(
    anonymousSessionId,
    documentId,
    folderId,
  );
  driveSyncInFlight.set(documentId, operation);
  try {
    return await operation;
  } finally {
    if (driveSyncInFlight.get(documentId) === operation) {
      driveSyncInFlight.delete(documentId);
    }
  }
}

export async function getDriveConnectionStatus(anonymousSessionId: string) {
  const connection = await db.orm.public.GoogleDriveConnection
    .where({ anonymousSessionId })
    .first();
  if (!connection || connection.status === "DISCONNECTED") {
    return { connected: false, provider: "google-drive" as const };
  }
  return {
    connected: connection.status === "CONNECTED",
    provider: "google-drive" as const,
    email: connection.googleEmail,
    status: connection.status,
    connectedAt: connection.connectedAt,
  };
}

export async function disconnectGoogleDrive(anonymousSessionId: string): Promise<void> {
  const connection = await db.orm.public.GoogleDriveConnection
    .where({ anonymousSessionId })
    .first();
  if (!connection || connection.status === "DISCONNECTED") return;

  try {
    const refreshToken = connection.encryptedRefreshToken
      ? decryptRefreshToken(connection.encryptedRefreshToken)
      : "";
    if (refreshToken) {
      const oauth = createOAuthClient();
      await oauth.revokeToken(refreshToken);
    }
  } catch {
    console.warn(
      JSON.stringify({
        event: "google_drive_token_revoke_failed",
        anonymousSessionId,
      }),
    );
  }

  await db.orm.public.GoogleDriveConnection
    .where({ id: connection.id })
    .update({
      encryptedRefreshToken: "",
      status: "DISCONNECTED",
      disconnectedAt: new Date(),
    });
  console.info(
    JSON.stringify({
      event: "google_drive_disconnected",
      anonymousSessionId,
    }),
  );
}

export async function listGoogleDriveFolders(
  anonymousSessionId: string,
  options: { parentFolderId?: string; pageToken?: string },
) {
  const { drive } = await getConnectedDriveClient(anonymousSessionId);
  const parent = options.parentFolderId ?? "root";
  const query = [
    `'${parent.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' in parents`,
    `mimeType = '${googleFolderMimeType}'`,
    "trashed = false",
  ].join(" and ");
  try {
    const response = await drive.files.list({
      q: query,
      spaces: "drive",
      pageSize: 100,
      pageToken: options.pageToken,
      orderBy: "name",
      fields: "nextPageToken,files(id,name,mimeType,parents)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      folders: (response.data.files ?? []).map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parents?.[0] ?? null,
      })),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  } catch (error) {
    throw await mapDriveError(error, anonymousSessionId);
  }
}

export async function createGoogleDriveFolder(
  anonymousSessionId: string,
  name: unknown,
  parentFolderId?: unknown,
) {
  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    name.trim().length > 100 ||
    /[\u0000-\u001f\u007f/\\]/.test(name)
  ) {
    throw new HttpError(400, "Folder name must be 1–100 characters without path separators");
  }
  const parent = validateDriveFolderId(parentFolderId);
  const { drive } = await getConnectedDriveClient(anonymousSessionId);
  if (parent) await assertAccessibleFolder(drive, parent, anonymousSessionId);
  try {
    const response = await drive.files.create({
      requestBody: {
        name: name.trim(),
        mimeType: googleFolderMimeType,
        ...(parent ? { parents: [parent] } : {}),
      },
      fields: "id,name",
      supportsAllDrives: true,
    });
    if (!response.data.id || !response.data.name) {
      throw new HttpError(502, "Google Drive did not return the created folder");
    }
    console.info(
      JSON.stringify({
        event: "google_drive_folder_created",
        anonymousSessionId,
        folderId: response.data.id,
      }),
    );
    return { id: response.data.id, name: response.data.name };
  } catch (error) {
    throw await mapDriveError(error, anonymousSessionId);
  }
}

async function syncGuestDocumentToDriveOnce(
  anonymousSessionId: string,
  documentId: string,
  folderId?: unknown,
) {
  const folder = validateDriveFolderId(folderId);
  const document = await db.orm.public.Document
    .where({ id: documentId, ownerSessionId: anonymousSessionId, userId: null })
    .first();
  if (!document) {
    throw new HttpError(404, "Document not found");
  }
  if (!document.storagePath || document.status !== "READY") {
    throw new HttpError(409, "A locally saved document is required before Drive upload");
  }
  if (document.driveSyncStatus === "UPLOADING") {
    throw new HttpError(409, "This document is already uploading to Google Drive");
  }

  const { drive } = await getConnectedDriveClient(anonymousSessionId);
  if (folder) await assertAccessibleFolder(drive, folder, anonymousSessionId);

  try {
    const priorCopy = await drive.files.list({
      q: `appProperties has { key='smartdocDocumentId' and value='${document.id}' } and trashed = false`,
      spaces: "drive",
      pageSize: 1,
      fields: "files(id,name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existingFile = priorCopy.data.files?.[0];
    if (existingFile?.id) {
      return await markDocumentSynced(
        document.id,
        existingFile.id,
        folder,
      );
    }
  } catch (error) {
    throw await mapDriveError(error, anonymousSessionId);
  }

  await db.orm.public.Document.where({ id: document.id }).update({
    driveSyncStatus: "UPLOADING",
  });
  console.info(
    JSON.stringify({
      event: "google_drive_upload_started",
      anonymousSessionId,
      documentId: document.id,
    }),
  );
  try {
    const response = await drive.files.create({
      requestBody: {
        name: document.name,
        mimeType: document.mimeType ?? "application/octet-stream",
        ...(folder ? { parents: [folder] } : {}),
        appProperties: { smartdocDocumentId: document.id },
      },
      media: {
        mimeType: document.mimeType ?? "application/octet-stream",
        body: createReadStream(resolveStoredUpload(document.storagePath)),
      },
      fields: "id,name",
      supportsAllDrives: true,
    });
    if (!response.data.id) {
      throw new HttpError(502, "Google Drive did not confirm the uploaded document");
    }
    return await markDocumentSynced(document.id, response.data.id, folder);
  } catch (error) {
    await db.orm.public.Document.where({ id: document.id }).update({
      driveSyncStatus: "FAILED",
    });
    console.warn(
      JSON.stringify({
        event: "google_drive_upload_failed",
        anonymousSessionId,
        documentId: document.id,
      }),
    );
    throw await mapDriveError(error, anonymousSessionId);
  }
}

async function markDocumentSynced(
  documentId: string,
  googleDriveFileId: string,
  googleDriveFolderId: string | null,
) {
  const document = await db.orm.public.Document
    .where({ id: documentId })
    .select(
      "id",
      "name",
      "fileType",
      "mimeType",
      "googleDriveFileId",
      "googleDriveFolderId",
      "driveSyncStatus",
      "syncedAt",
    )
    .update({
      googleDriveFileId,
      googleDriveFolderId,
      driveSyncStatus: "SYNCED",
      syncedAt: new Date(),
    });
  console.info(
    JSON.stringify({
      event: "google_drive_upload_succeeded",
      documentId,
      googleDriveFileId,
    }),
  );
  return document;
}

async function assertAccessibleFolder(
  drive: Awaited<ReturnType<typeof getConnectedDriveClient>>["drive"],
  folderId: string,
  anonymousSessionId: string,
): Promise<void> {
  try {
    const response = await drive.files.get({
      fileId: folderId,
      fields: "id,mimeType,trashed",
      supportsAllDrives: true,
    });
    if (
      response.data.mimeType !== googleFolderMimeType ||
      response.data.trashed === true
    ) {
      throw new HttpError(404, "Google Drive folder is unavailable");
    }
  } catch (error) {
    throw await mapDriveError(error, anonymousSessionId);
  }
}

function validateDriveFolderId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new HttpError(400, "Google Drive folder ID is invalid");
  }
  return value;
}

async function mapDriveError(
  error: unknown,
  anonymousSessionId: string,
): Promise<HttpError> {
  if (error instanceof HttpError) return error;
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const response =
    record["response"] !== null && typeof record["response"] === "object"
      ? (record["response"] as Record<string, unknown>)
      : {};
  const status = response["status"] ?? record["code"];
  const data =
    response["data"] !== null && typeof response["data"] === "object"
      ? (response["data"] as Record<string, unknown>)
      : {};
  const googleError =
    data["error"] !== null && typeof data["error"] === "object"
      ? (data["error"] as Record<string, unknown>)
      : {};
  const reason =
    typeof googleError["status"] === "string"
      ? googleError["status"]
      : typeof googleError["message"] === "string"
        ? googleError["message"]
        : "";
  if (status === 401 || reason.toLowerCase().includes("invalid_grant")) {
    await db.orm.public.GoogleDriveConnection
      .where({ anonymousSessionId })
      .update({ status: "REAUTH_REQUIRED" });
    console.warn(
      JSON.stringify({
        event: "google_drive_authorization_expired",
        anonymousSessionId,
      }),
    );
    return new HttpError(
      409,
      "Google Drive connection expired. Please reconnect.",
      "DRIVE_REAUTH_REQUIRED",
    );
  }
  if (status === 403) {
    return new HttpError(
      403,
      "SmartDoc does not have permission to access this Drive folder.",
    );
  }
  if (
    reason.toLowerCase().includes("quota") ||
    reason.toLowerCase().includes("storage")
  ) {
    return new HttpError(
      429,
      "Google Drive storage or API quota has been exceeded.",
    );
  }
  if (status === 404) {
    return new HttpError(404, "Google Drive folder or document was not found");
  }
  return new HttpError(502, "Unable to connect to Google Drive. Please try again.");
}
