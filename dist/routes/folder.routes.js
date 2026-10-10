import { Router } from "express";
import { createGuestFolder, deleteGuestFolder, getFolderDocuments, getGuestFolder, listGuestFolders, updateGuestFolder, } from "../services/folder.service.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { parseId, parsePage, requireObjectBody, requireSessionResponseContext, } from "../utils/requestValidation.js";
export const folderRouter = Router();
folderRouter.get("/", async (_req, res) => {
    res.json({
        success: true,
        folders: await listGuestFolders(requireSessionResponseContext(res)),
    });
});
folderRouter.post("/", async (req, res) => {
    const folder = await createGuestFolder(requireSessionResponseContext(res), requireObjectBody(req.body));
    res.status(201).json({ success: true, folder });
});
folderRouter.get("/:id/documents", async (req, res) => {
    const documents = await getFolderDocuments(requireSessionResponseContext(res), parseId(req.params.id), parseDocumentOptions(req.query));
    res.json({ success: true, ...documents });
});
folderRouter.get("/:id", async (req, res) => {
    const folder = await getGuestFolder(requireSessionResponseContext(res), parseId(req.params.id));
    res.json({ success: true, folder });
});
folderRouter.put("/:id", async (req, res) => {
    const folder = await updateGuestFolder(requireSessionResponseContext(res), parseId(req.params.id), requireObjectBody(req.body));
    res.json({ success: true, folder });
});
folderRouter.delete("/:id", async (req, res) => {
    await deleteGuestFolder(requireSessionResponseContext(res), parseId(req.params.id));
    res.json({ success: true, message: "Folder deleted; its documents remain available" });
});
function parseDocumentOptions(query) {
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
    const fileType = query.fileType;
    if (fileType !== undefined && typeof fileType !== "string") {
        throw new HttpError(400, "fileType must be a single string value");
    }
    if (typeof fileType === "string" && !env.allowedDocumentTypes.has(fileType.toLowerCase())) {
        throw new HttpError(400, "fileType is not allowed");
    }
    const status = query.status;
    if (status !== undefined && status !== "UPLOADING" && status !== "READY" && status !== "FAILED" && status !== "DELETED") {
        throw new HttpError(400, "status is invalid");
    }
    return {
        page,
        limit,
        sortBy,
        sortOrder,
        ...(typeof fileType === "string" ? { fileType: fileType.toLowerCase() } : {}),
        ...(typeof status === "string" ? { status } : {}),
    };
}
