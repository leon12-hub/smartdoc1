import { db } from "../prisma/db.js";
import { or } from "@prisma/orm-postgres/orm-client";
import { HttpError } from "../utils/httpError.js";
import {
  removeTemporaryFile,
  restoreStagedFile,
  stageStoredFileForDeletion,
} from "../utils/uploadStorage.js";
import { env } from "../config/env.js";
import { mimeTypeForExtension } from "../utils/uploadStorage.js";

const publicDocumentFields = [
  "id",
  "name",
  "fileType",
  "fileSize",
  "mimeType",
  "pageCount",
  "source",
  "storageProvider",
  "status",
  "googleDriveFileId",
  "googleDriveFolderId",
  "driveSyncStatus",
  "adminGoogleDriveFileId",
  "adminGoogleDriveFolderId",
  "adminDriveSyncStatus",
  "syncedAt",
  "analysisStatus",
  "folderId",
  "createdAt",
  "updatedAt",
] as const;

export interface DocumentListOptions {
  page: number;
  limit: number;
  sortBy: "createdAt" | "name" | "fileSize";
  sortOrder: "asc" | "desc";
  folderId?: string;
  status?: "UPLOADING" | "READY" | "FAILED" | "DELETED";
  fileType?: string;
  search?: string;
}

export async function listGuestDocuments(sessionId: string, options: DocumentListOptions) {
  let query = db.orm.public.Document
    .where({ ownerSessionId: sessionId, userId: null });

  if (options.folderId) {
    query = query.where({ folderId: options.folderId });
  }
  if (options.status) {
    query = query.where({ status: options.status });
  }
  if (options.fileType) {
    query = query.where({ fileType: options.fileType });
  }
  if (options.search) {
    const pattern = `%${escapeLikePattern(options.search)}%`;
    query = query.where((document) =>
      or(
        document.name.ilike(pattern),
        document.fileType.ilike(pattern),
        document.mimeType.ilike(pattern),
        document.extractedText.ilike(pattern),
      ),
    );
  }

  const [total, documents] = await Promise.all([
    query.aggregate((aggregate) => ({ total: aggregate.count() })),
    sortDocuments(query, options)
      .select(...publicDocumentFields)
      .limit(options.limit)
      .offset((options.page - 1) * options.limit)
      .all(),
  ]);

  return {
    data: documents,
    pagination: {
      page: options.page,
      limit: options.limit,
      total: total.total,
      totalPages: total.total === 0 ? 0 : Math.ceil(total.total / options.limit),
    },
  };
}

export async function createGuestDocument(
  sessionId: string,
  input: Record<string, unknown>,
  storagePath: string | null = null,
) {
  const allowedKeys = new Set([
    "name",
    "fileType",
    "fileSize",
    "mimeType",
    "pageCount",
    "source",
    "folderId",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, "Document contains unsupported fields");
  }
  const name = validateDocumentName(input.name);

  const fileType = optionalString(input.fileType, "fileType", 10);
  const mimeType = optionalString(input.mimeType, "mimeType", 100);
  if (fileType && !env.allowedDocumentTypes.has(fileType.toLowerCase())) {
    throw new HttpError(400, "fileType is not an allowed document type");
  }
  if (mimeType && fileType && mimeTypeForExtension(fileType.toLowerCase()) !== mimeType) {
    throw new HttpError(400, "mimeType must match fileType");
  }
  const fileSize = input.fileSize;
  if (
    fileSize !== undefined &&
    fileSize !== null &&
    (
      typeof fileSize !== "number" ||
      !Number.isSafeInteger(fileSize) ||
      fileSize < 0 ||
      fileSize > 2_147_483_647
    )
  ) {
    throw new HttpError(400, "fileSize must be a non-negative 32-bit integer");
  }
  const pageCount = parsePageCount(input.pageCount);
  const source = input.source ?? "UPLOAD";
  if (source !== "UPLOAD" && source !== "SCAN") {
    throw new HttpError(400, "source must be UPLOAD or SCAN");
  }
  if (pageCount !== null && (fileType?.toLowerCase() !== "pdf" || source !== "SCAN")) {
    throw new HttpError(400, "pageCount is supported only for scanned PDF documents");
  }

  const folderId = optionalString(input.folderId, "folderId", 100);
  if (folderId) {
    const folder = await db.orm.public.Folder.first({ id: folderId });
    if (!folder || folder.ownerSessionId !== sessionId || folder.userId !== null) {
      throw new HttpError(404, "Folder not found");
    }
  }

  const document = await db.orm.public.Document
    .select(...publicDocumentFields)
    .create({
      name,
      fileType: fileType ?? null,
      fileSize: typeof fileSize === "number" ? fileSize : null,
      mimeType: mimeType ?? null,
      pageCount,
      source,
      googleDriveFileId: null,
      folderId: folderId ?? null,
      ownerSessionId: sessionId,
      storagePath,
      storageProvider: "LOCAL",
      status: "READY",
      analysisStatus: "NOT_REQUESTED",
      userId: null,
    });

  return document;
}

function parsePageCount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const pageCount =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,4}$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1000) {
    throw new HttpError(400, "pageCount must be an integer between 1 and 1000");
  }
  return pageCount;
}

export async function getGuestDocumentDownload(sessionId: string, id: string) {
  const document = await db.orm.public.Document
    .select("id", "name", "fileType", "mimeType", "storageProvider", "status", "googleDriveFileId", "storagePath")
    .where({ id, ownerSessionId: sessionId, userId: null })
    .first();

  if (!document) {
    throw new HttpError(404, "Document not found");
  }
  const storagePath = document.storagePath;
  if (!storagePath) {
    if (document.googleDriveFileId) {
      throw new HttpError(501, "Google Drive downloads are not configured yet");
    }
    throw new HttpError(404, "This document has no stored file");
  }
  if (document.status !== "READY") {
    throw new HttpError(409, "This document is not ready to download");
  }

  return { ...document, storagePath };
}

export async function getGuestDocument(sessionId: string, id: string) {
  const document = await db.orm.public.Document
    .select(...publicDocumentFields, "extractedText", "aiSummary")
    .where({ id, ownerSessionId: sessionId, userId: null })
    .first();

  if (!document) {
    throw new HttpError(404, "Document not found");
  }
  return document;
}

export async function searchGuestDocuments(sessionId: string, options: DocumentListOptions) {
  if (!options.search) {
    throw new HttpError(400, "Search query q is required");
  }
  return listGuestDocuments(sessionId, options);
}

export async function deleteGuestDocument(sessionId: string, id: string): Promise<void> {
  const document = await db.orm.public.Document
    .where({ id, ownerSessionId: sessionId, userId: null })
    .first();
  if (!document) {
    throw new HttpError(404, "Document not found");
  }

  const stagedFile = document.storagePath
    ? await stageStoredFileForDeletion(document.storagePath)
    : null;
  try {
    await db.orm.public.Document
      .where({ id: document.id, ownerSessionId: sessionId, userId: null })
      .delete();
  } catch (error) {
    if (stagedFile && document.storagePath) {
      await restoreStagedFile(document.storagePath, stagedFile);
    }
    throw error;
  }
  if (stagedFile) {
    await removeTemporaryFile(stagedFile);
  }
}

export async function updateGuestDocument(
  sessionId: string,
  id: string,
  input: Record<string, unknown>,
) {
  const current = await db.orm.public.Document
    .where({ id, ownerSessionId: sessionId, userId: null })
    .first();
  if (!current) {
    throw new HttpError(404, "Document not found");
  }

  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => key !== "name" && key !== "folderId")) {
    throw new HttpError(400, "Only name and folderId can be updated");
  }

  const update: { name?: string; folderId?: string | null } = {};
  if ("name" in input) {
    update.name = validateDocumentName(input.name);
  }
  if ("folderId" in input) {
    const folderId = input.folderId;
    if (folderId !== null && (typeof folderId !== "string" || folderId.length > 100)) {
      throw new HttpError(400, "folderId must be a valid folder ID or null");
    }
    if (typeof folderId === "string") {
      const folder = await db.orm.public.Folder.first({ id: folderId });
      if (!folder || folder.ownerSessionId !== sessionId || folder.userId !== null) {
        throw new HttpError(404, "Folder not found");
      }
    }
    update.folderId = folderId;
  }

  return db.orm.public.Document
    .where({ id, ownerSessionId: sessionId, userId: null })
    .select(...publicDocumentFields)
    .update(update);
}

export async function listFolderDocuments(
  sessionId: string,
  folderId: string,
  options: DocumentListOptions,
) {
  const folder = await db.orm.public.Folder
    .where({ id: folderId, ownerSessionId: sessionId, userId: null })
    .first();
  if (!folder) {
    throw new HttpError(404, "Folder not found");
  }
  return listGuestDocuments(sessionId, { ...options, folderId });
}

export async function previewGuestDocument(sessionId: string, id: string) {
  const document = await getGuestDocumentDownload(sessionId, id);
  const mimeType = document.mimeType;
  if (
    mimeType !== "application/pdf" &&
    mimeType !== "image/jpeg" &&
    mimeType !== "image/png" &&
    mimeType !== "image/webp"
  ) {
    throw new HttpError(415, "This document type cannot be previewed in the browser");
  }
  return { ...document, mimeType };
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, `${field} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function validateDocumentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(value)
  ) {
    throw new HttpError(400, "Document name must be 1–255 characters without path separators");
  }
  return value.trim();
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function sortDocuments(
  query: ReturnType<typeof db.orm.public.Document.select>,
  options: DocumentListOptions,
) {
  switch (options.sortBy) {
    case "name":
      return options.sortOrder === "asc"
        ? query.orderBy((document) => document.name.asc())
        : query.orderBy((document) => document.name.desc());
    case "fileSize":
      return options.sortOrder === "asc"
        ? query.orderBy((document) => document.fileSize.asc({ nulls: "last" }))
        : query.orderBy((document) => document.fileSize.desc({ nulls: "last" }));
    default:
      return options.sortOrder === "asc"
        ? query.orderBy((document) => document.createdAt.asc())
        : query.orderBy((document) => document.createdAt.desc());
  }
}
