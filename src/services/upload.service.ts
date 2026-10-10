import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import type { Request } from "express";
import { resolve } from "node:path";
import { createGuestDocument } from "./document.service.js";
import { syncNewGuestDocumentToAdminDrive } from "./google/adminGoogleDriveSync.service.js";
import { HttpError } from "../utils/httpError.js";
import { env } from "../config/env.js";
import {
  documentDirectory,
  hasMatchingSignature,
  mimeTypeForExtension,
  removeTemporaryFile,
  safeOriginalName,
} from "../utils/uploadStorage.js";

export async function storeGuestUpload(
  sessionId: string,
  input: Record<string, unknown>,
  file: NonNullable<Request["file"]>,
) {
  const fileType = file.mimetype.toLowerCase();
  let storedPath: string | undefined;
  try {
    const { name: originalName, extension } = safeOriginalName(file.originalname);
    if (!env.allowedDocumentTypes.has(extension)) {
      throw new HttpError(415, "This document file type is not allowed");
    }
    const expectedMimeType = mimeTypeForExtension(extension);
    if (expectedMimeType !== fileType) {
      throw new HttpError(415, "File extension and MIME type do not match");
    }
    if (file.size < 1 || file.size > env.maxFileSizeMb * 1024 * 1024) {
      throw new HttpError(413, `File size must be between 1 byte and ${env.maxFileSizeMb} MB`);
    }
    const fileStats = await stat(file.path);
    if (fileStats.size !== file.size) {
      throw new HttpError(400, "Uploaded file size does not match the received file");
    }
    const fileBuffer = await readFile(file.path);
    if (!hasMatchingSignature(fileBuffer, fileType)) {
      throw new HttpError(415, "The uploaded file contents do not match its declared type");
    }

    const fileName = `${randomUUID()}.${extension}`;
    storedPath = resolve(documentDirectory, fileName);
    const submittedName = input.name;
    const name = typeof submittedName === "string" && submittedName.trim()
      ? validateDisplayName(submittedName)
      : originalName;

    await mkdir(documentDirectory, { recursive: true });
    await rename(file.path, storedPath);

    const document = await createGuestDocument(
      sessionId,
      {
        ...input,
        name,
        fileType: extension,
        mimeType: fileType,
        fileSize: file.size,
      },
      fileName,
    );
    try {
      const syncedDocument = await syncNewGuestDocumentToAdminDrive(document.id);
      return syncedDocument ? { ...document, ...syncedDocument } : document;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "admin_google_drive_document_sync_failed",
        documentId: document.id,
        reason: error instanceof Error ? error.message : "drive_sync_failed",
      }));
      return { ...document, adminDriveSyncStatus: "FAILED" as const };
    }
  } catch (error) {
    if (storedPath) {
      await unlink(storedPath);
    }
    throw error;
  } finally {
    await removeTemporaryFile(file.path);
  }
}

function validateDisplayName(value: string): string {
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new HttpError(400, "Document name must be 1–255 characters without path separators");
  }
  return name;
}
