import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import multer from "multer";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { safeOriginalName, temporaryDirectory } from "../utils/uploadStorage.js";
import { mimeTypeForExtension } from "../utils/uploadStorage.js";
export const uploadSizeLimitBytes = env.maxFileSizeMb * 1024 * 1024;
export const singleDocumentUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => {
            mkdir(temporaryDirectory, { recursive: true })
                .then(() => callback(null, temporaryDirectory))
                .catch((error) => callback(error instanceof Error ? error : new Error("Could not create upload temporary directory"), ""));
        },
        filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: uploadSizeLimitBytes, files: 1, fields: 5, parts: 6 },
    fileFilter: (_req, file, callback) => {
        let validatedName;
        try {
            validatedName = safeOriginalName(file.originalname);
        }
        catch (error) {
            callback(error instanceof Error ? error : new HttpError(400, "Uploaded filename is invalid"));
            return;
        }
        const expectedMimeType = mimeTypeForExtension(validatedName.extension);
        if (!env.allowedDocumentTypes.has(validatedName.extension) ||
            expectedMimeType !== file.mimetype.toLowerCase()) {
            callback(new HttpError(415, "File extension and MIME type must match an allowed document type"));
            return;
        }
        callback(null, true);
    },
});
