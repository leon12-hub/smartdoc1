import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { env } from "../config/env.js";
import {
  createGuestDocument,
  deleteGuestDocument,
  getGuestDocument,
  getGuestDocumentDownload,
  listGuestDocuments,
  previewGuestDocument,
  searchGuestDocuments,
  updateGuestDocument,
  type DocumentListOptions,
} from "../services/document.service.js";
import { singleDocumentUpload } from "../middleware/upload.middleware.js";
import { storeGuestUpload } from "../services/upload.service.js";
import { resolveStoredUpload, removeTemporaryFile } from "../utils/uploadStorage.js";
import {
  parseId,
  parsePage,
  requireObjectBody,
  requireSessionResponseContext,
} from "../utils/requestValidation.js";
import { HttpError } from "../utils/httpError.js";
import { requestDocumentAnalysis } from "../services/documentAnalysis.service.js";

export const documentRouter = Router();

documentRouter.get("/search", async (req, res) => {
  const options = parseDocumentListOptions(req.query);
  res.json({
    success: true,
    ...(await searchGuestDocuments(requireSessionResponseContext(res), options)),
  });
});

documentRouter.get("/", async (req, res) => {
  res.json({
    success: true,
    ...(await listGuestDocuments(
      requireSessionResponseContext(res),
      parseDocumentListOptions(req.query),
    )),
  });
});

documentRouter.post("/", async (req, res) => {
  const document = await createGuestDocument(
    requireSessionResponseContext(res),
    requireObjectBody(req.body),
  );
  res.status(201).json({ success: true, document });
});

documentRouter.post("/upload", singleDocumentUpload.single("file"), async (req, res) => {
  if (!req.file) {
    throw new HttpError(400, "A file is required in the 'file' field");
  }
  try {
    const document = await storeGuestUpload(
      requireSessionResponseContext(res),
      requireObjectBody(req.body),
      req.file,
    );
    res.status(201).json({ success: true, document });
  } catch (error) {
    await removeTemporaryFile(req.file.path);
    throw error;
  }
});

documentRouter.get("/:id/download", async (req, res, next) => {
  const document = await getGuestDocumentDownload(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  try {
    await streamDocument(document, res, "attachment");
  } catch (error) {
    if (!res.headersSent && isMissingFile(error)) {
      next(new HttpError(404, "Document file is unavailable"));
      return;
    }
    next(error);
  }
});

documentRouter.get("/:id/preview", async (req, res, next) => {
  const document = await previewGuestDocument(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  try {
    await streamDocument(document, res, "inline");
  } catch (error) {
    if (!res.headersSent && isMissingFile(error)) {
      next(new HttpError(404, "Document file is unavailable"));
      return;
    }
    next(error);
  }
});

documentRouter.get("/:id", async (req, res) => {
  const document = await getGuestDocument(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  res.json({ success: true, document });
});

documentRouter.put("/:id", async (req, res) => {
  const document = await updateGuestDocument(
    requireSessionResponseContext(res),
    parseId(req.params.id),
    requireObjectBody(req.body),
  );
  res.json({ success: true, document });
});

documentRouter.delete("/:id", async (req, res) => {
  await deleteGuestDocument(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  res.json({ success: true, message: "Document deleted" });
});

documentRouter.post("/:id/analyze", async (req, res) => {
  const result = await requestDocumentAnalysis(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  res.status(202).json({ success: true, ...result });
});

function parseDocumentListOptions(query: Record<string, unknown>): DocumentListOptions {
  const page = parsePage(query.page, 1, 1_000_000);
  const limit = parsePage(query.limit, 20, 100);
  const sortBy = query.sortBy ?? "createdAt";
  if (sortBy !== "createdAt" && sortBy !== "name" && sortBy !== "fileSize") {
    throw new HttpError(400, "sortBy must be createdAt, name, or fileSize");
  }
  const sortOrder = query.sortOrder ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") {
    throw new HttpError(400, "sortOrder must be asc or desc");
  }
  const folderId = query.folderId === undefined ? undefined : parseId(requireQueryString(query.folderId, "folderId"));
  const status = query.status;
  if (status !== undefined && status !== "UPLOADING" && status !== "READY" && status !== "FAILED" && status !== "DELETED") {
    throw new HttpError(400, "status is invalid");
  }
  const fileType = query.fileType === undefined
    ? undefined
    : requireQueryString(query.fileType, "fileType").toLowerCase();
  if (fileType && !env.allowedDocumentTypes.has(fileType)) {
    throw new HttpError(400, "fileType is not allowed");
  }
  const search = query.q === undefined ? undefined : requireQueryString(query.q, "q").trim();
  if (search !== undefined && (search.length < 1 || search.length > 100)) {
    throw new HttpError(400, "Search query must be between 1 and 100 characters");
  }

  return {
    page,
    limit,
    sortBy,
    sortOrder,
    ...(folderId ? { folderId } : {}),
    ...(status ? { status } : {}),
    ...(fileType ? { fileType } : {}),
    ...(search ? { search } : {}),
  };
}

function requireQueryString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single string value`);
  }
  return value;
}

async function streamDocument(
  document: { name: string; mimeType: string | null; storagePath: string },
  res: import("express").Response,
  disposition: "inline" | "attachment",
): Promise<void> {
  const filePath = resolveStoredUpload(document.storagePath);
  const safeName = document.name.replace(/[\r\n"\\]/g, "_");
  const encodedName = encodeURIComponent(safeName).replace(/['()]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_");

  res.setHeader("Content-Type", document.mimeType ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (disposition === "inline") {
    res.setHeader("Content-Security-Policy", "sandbox");
  }
  await pipeline(createReadStream(filePath), res);
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
