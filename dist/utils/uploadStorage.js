import { mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { HttpError } from "./httpError.js";
const configuredStorageDirectory = process.env.STORAGE_DIR?.trim();
export const storageDirectory = configuredStorageDirectory
    ? resolve(configuredStorageDirectory)
    : resolve(fileURLToPath(new URL("../../storage", import.meta.url)));
export const documentDirectory = resolve(storageDirectory, "documents");
export const temporaryDirectory = resolve(storageDirectory, "temporary");
export function resolveStoredUpload(storagePath) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp)$/i.test(storagePath)) {
        throw new HttpError(500, "Stored document path is invalid");
    }
    return resolve(documentDirectory, basename(storagePath));
}
export async function deleteStoredFile(storagePath) {
    try {
        await unlink(resolveStoredUpload(storagePath));
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
}
export async function stageStoredFileForDeletion(storagePath) {
    const sourcePath = resolveStoredUpload(storagePath);
    const temporaryPath = resolve(temporaryDirectory, `${randomUUID()}.deleting`);
    await mkdir(temporaryDirectory, { recursive: true });
    try {
        await rename(sourcePath, temporaryPath);
        return temporaryPath;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export async function restoreStagedFile(storagePath, temporaryPath) {
    await mkdir(documentDirectory, { recursive: true });
    await rename(temporaryPath, resolveStoredUpload(storagePath));
}
export async function removeTemporaryFile(filePath) {
    if (!filePath) {
        return;
    }
    const resolvedPath = resolve(filePath);
    const pathFromTemporaryDirectory = relative(temporaryDirectory, resolvedPath);
    if (!pathFromTemporaryDirectory ||
        pathFromTemporaryDirectory === ".." ||
        pathFromTemporaryDirectory.startsWith(`..${sep}`) ||
        relative(temporaryDirectory, resolvedPath).startsWith(sep)) {
        return;
    }
    try {
        await unlink(resolvedPath);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
}
export function safeOriginalName(name) {
    const filename = basename(name.replaceAll("\\", "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 255);
    const match = /^(.+)\.(pdf|jpe?g|png|webp)$/i.exec(filename);
    if (!match || !match[1].trim()) {
        throw new HttpError(400, "Uploaded file must have a valid filename");
    }
    return { name: filename, extension: match[2].toLowerCase() };
}
export function hasMatchingSignature(buffer, mimeType) {
    switch (mimeType) {
        case "application/pdf":
            return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
        case "image/jpeg":
            return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
        case "image/png":
            return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case "image/webp":
            return (buffer.length >= 12 &&
                buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
                buffer.subarray(8, 12).toString("ascii") === "WEBP");
        default:
            return false;
    }
}
export function mimeTypeForExtension(extension) {
    const mimeTypes = {
        pdf: "application/pdf",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) {
        throw new HttpError(415, "This document file type is not supported");
    }
    return mimeType;
}
export function extensionForMimeType(mimeType) {
    switch (mimeType.toLowerCase()) {
        case "application/pdf":
            return "pdf";
        case "image/jpeg":
            return "jpg";
        case "image/png":
            return "png";
        case "image/webp":
            return "webp";
        default:
            return null;
    }
}
