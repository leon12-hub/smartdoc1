import { db } from "../prisma/db.js";
import { HttpError } from "../utils/httpError.js";
import { Temporal } from "temporal-polyfill";
import { listFolderDocuments } from "./document.service.js";
import { syncNewGuestFolderToAdminDrive } from "./google/adminGoogleDriveSync.service.js";
const publicFolderFields = [
    "id",
    "name",
    "googleDriveFolderId",
    "adminGoogleDriveFolderId",
    "adminDriveSyncStatus",
    "createdAt",
    "updatedAt",
];
export async function listGuestFolders(sessionId) {
    const folders = await db.orm.public.Folder
        .select(...publicFolderFields)
        .where({ ownerSessionId: sessionId, userId: null })
        .include("documents", (documents) => documents.where({ ownerSessionId: sessionId, userId: null }).count())
        .orderBy((folder) => folder.createdAt.desc())
        .all();
    return folders.map(({ documents, ...folder }) => ({ ...folder, documentCount: documents }));
}
export async function getGuestFolder(sessionId, id) {
    const folder = await db.orm.public.Folder
        .select(...publicFolderFields)
        .where({ id, ownerSessionId: sessionId, userId: null })
        .first();
    if (!folder) {
        throw new HttpError(404, "Folder not found");
    }
    const documentCount = await db.orm.public.Document
        .where({ folderId: id, ownerSessionId: sessionId, userId: null })
        .aggregate((aggregate) => ({ total: aggregate.count() }));
    return { ...folder, documentCount: documentCount.total };
}
export async function createGuestFolder(sessionId, input) {
    if (Object.keys(input).some((key) => key !== "name")) {
        throw new HttpError(400, "Only the folder name can be provided");
    }
    const name = validateFolderName(input.name);
    const folder = await db.orm.public.Folder
        .select(...publicFolderFields)
        .create({
        name,
        googleDriveFolderId: null,
        adminGoogleDriveFolderId: null,
        adminDriveSyncStatus: "LOCAL_ONLY",
        ownerSessionId: sessionId,
        userId: null,
    });
    try {
        await syncNewGuestFolderToAdminDrive(folder.id);
    }
    catch (error) {
        console.warn(JSON.stringify({
            event: "admin_google_drive_folder_sync_failed",
            folderId: folder.id,
            reason: error instanceof Error ? error.message : "drive_sync_failed",
        }));
    }
    return getGuestFolder(sessionId, folder.id);
}
export async function updateGuestFolder(sessionId, id, input) {
    const folder = await db.orm.public.Folder
        .where({ id, ownerSessionId: sessionId, userId: null })
        .first();
    if (!folder) {
        throw new HttpError(404, "Folder not found");
    }
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "name") {
        throw new HttpError(400, "Only the folder name can be updated");
    }
    const name = validateFolderName(input.name);
    return db.orm.public.Folder
        .where({ id, ownerSessionId: sessionId, userId: null })
        .select(...publicFolderFields)
        .update({ name, updatedAt: Temporal.Now.instant() });
}
export async function getFolderDocuments(sessionId, folderId, options) {
    return listFolderDocuments(sessionId, folderId, options);
}
export async function deleteGuestFolder(sessionId, id) {
    const folder = await db.orm.public.Folder
        .where({ id, ownerSessionId: sessionId, userId: null })
        .first();
    if (!folder) {
        throw new HttpError(404, "Folder not found");
    }
    await db.orm.public.Folder.where({ id: folder.id }).delete();
}
function validateFolderName(value) {
    if (typeof value !== "string" ||
        value.trim().length === 0 ||
        value.trim().length > 100 ||
        /[\u0000-\u001f\u007f/\\]/.test(value)) {
        throw new HttpError(400, "Folder name must be 1–100 characters without path separators");
    }
    return value.trim();
}
