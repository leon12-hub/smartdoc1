import { createHash } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
import { createGoogleDriveFolder, listGoogleDriveFolders } from "./google/googleDrive.service.js";

export async function registerDeviceUser(
  anonymousSessionId: string,
  name?: unknown,
): Promise<{
  userId: string;
  installationId: string;
  driveFolderId: string;
  folderName: string;
  documentsFolderId: string;
  scannedDocumentsFolderId: string;
}> {
  const displayName = sanitizeUserName(name) ?? `User-${makeShortId(anonymousSessionId)}`;
  const userId = `SD-${makeShortId(anonymousSessionId, 8).toUpperCase()}`;

  try {
    const rootFolder = await ensureFolder(anonymousSessionId, "SmartDoc");
    const usersFolder = await ensureFolder(anonymousSessionId, "Users", rootFolder.id);
    const userFolder = await ensureFolder(anonymousSessionId, displayName, usersFolder.id);
    const documentsFolder = await ensureFolder(anonymousSessionId, "Documents", userFolder.id);
    const scannedFolder = await ensureFolder(anonymousSessionId, "Scanned Documents", userFolder.id);

    return {
      userId,
      installationId: anonymousSessionId,
      driveFolderId: userFolder.id,
      folderName: userFolder.name,
      documentsFolderId: documentsFolder.id,
      scannedDocumentsFolderId: scannedFolder.id,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 409 || error.status === 503) {
        throw new HttpError(
          503,
          "The SmartDoc admin Google Drive is not connected yet. Please ask the administrator to connect Google Drive before creating user folders.",
        );
      }
      throw error;
    }
    throw new HttpError(500, "SmartDoc could not create the assigned Drive folder for this device.");
  }
}

async function ensureFolder(
  anonymousSessionId: string,
  name: string,
  parentFolderId?: string,
): Promise<{ id: string; name: string }> {
  const folders = await listGoogleDriveFolders(anonymousSessionId, {
    parentFolderId: parentFolderId ?? "root",
  });
  const existing = folders.folders.find((folder) => folder.name === name);
  if (existing) {
    return {
      id: String(existing.id ?? ""),
      name: String(existing.name ?? name),
    };
  }
  return createGoogleDriveFolder(anonymousSessionId, name, parentFolderId);
}

function sanitizeUserName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) return null;
  return trimmed
    .replace(/[\\/]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

function makeShortId(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
