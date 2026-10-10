import { createReadStream } from "node:fs";
import { Temporal } from "temporal-polyfill";
import { db } from "../../prisma/db.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../utils/httpError.js";
import { resolveStoredUpload } from "../../utils/uploadStorage.js";
import { getConnectedAdminDriveClient } from "./googleToken.service.js";
const googleFolderMimeType = "application/vnd.google-apps.folder";
export async function syncNewGuestFolderToAdminDrive(folderId) {
    const folder = await db.orm.public.Folder.where({ id: folderId }).first();
    if (!folder || folder.userId !== null || !folder.ownerSessionId) {
        throw new HttpError(404, "SmartDoc folder not found");
    }
    const context = await getAdminDriveContext();
    if (!context)
        return null;
    if (folder.adminDriveSyncStatus === "SYNCED" && folder.adminGoogleDriveFolderId) {
        return folder;
    }
    await db.orm.public.Folder
        .where({ id: folder.id })
        .update({ adminDriveSyncStatus: "UPLOADING" });
    try {
        const parentFolderId = await getOrCreateSyncRoot(context);
        const existing = await context.drive.files.list({
            q: `appProperties has { key='smartdocAdminFolderId' and value='${folder.id}' } and trashed = false`,
            spaces: "drive",
            pageSize: 1,
            fields: "files(id)",
        });
        let googleDriveFolderId = existing.data.files?.[0]?.id;
        if (!googleDriveFolderId) {
            const response = await context.drive.files.create({
                requestBody: {
                    name: folder.name,
                    mimeType: googleFolderMimeType,
                    parents: [parentFolderId],
                    appProperties: { smartdocAdminFolderId: folder.id },
                },
                fields: "id",
            });
            googleDriveFolderId = response.data.id ?? undefined;
        }
        if (!googleDriveFolderId) {
            throw new HttpError(502, "Google Drive did not confirm the folder sync");
        }
        return await db.orm.public.Folder
            .where({ id: folder.id })
            .select("id", "name", "adminGoogleDriveFolderId", "adminDriveSyncStatus")
            .update({
            adminGoogleDriveFolderId: googleDriveFolderId,
            adminDriveSyncStatus: "SYNCED",
        });
    }
    catch (error) {
        await db.orm.public.Folder
            .where({ id: folder.id })
            .update({ adminDriveSyncStatus: "FAILED" });
        throw error;
    }
}
export async function syncNewGuestDocumentToAdminDrive(documentId) {
    const document = await db.orm.public.Document.where({ id: documentId }).first();
    if (!document ||
        document.userId !== null ||
        !document.ownerSessionId ||
        !document.storagePath ||
        document.status !== "READY") {
        return null;
    }
    const context = await getAdminDriveContext();
    if (!context)
        return null;
    if (document.adminDriveSyncStatus === "SYNCED" && document.adminGoogleDriveFileId) {
        return document;
    }
    await db.orm.public.Document
        .where({ id: document.id })
        .update({ adminDriveSyncStatus: "UPLOADING" });
    try {
        const rootFolderId = await getOrCreateSyncRoot(context);
        let parentFolderId = rootFolderId;
        if (document.folderId) {
            const folder = await db.orm.public.Folder.where({ id: document.folderId }).first();
            if (folder &&
                (folder.adminDriveSyncStatus === "SYNCED" ||
                    Temporal.Instant.compare(folder.createdAt, context.connection.connectedAt) >= 0)) {
                const syncedFolder = await syncNewGuestFolderToAdminDrive(folder.id);
                parentFolderId = syncedFolder?.adminGoogleDriveFolderId ?? rootFolderId;
            }
        }
        const existing = await context.drive.files.list({
            q: `appProperties has { key='smartdocAdminDocumentId' and value='${document.id}' } and trashed = false`,
            spaces: "drive",
            pageSize: 1,
            fields: "files(id)",
        });
        let googleDriveFileId = existing.data.files?.[0]?.id;
        if (!googleDriveFileId) {
            const response = await context.drive.files.create({
                requestBody: {
                    name: document.name,
                    mimeType: document.mimeType ?? "application/octet-stream",
                    parents: [parentFolderId],
                    appProperties: { smartdocAdminDocumentId: document.id },
                },
                media: {
                    mimeType: document.mimeType ?? "application/octet-stream",
                    body: createReadStream(resolveStoredUpload(document.storagePath)),
                },
                fields: "id",
            });
            googleDriveFileId = response.data.id ?? undefined;
        }
        if (!googleDriveFileId) {
            throw new HttpError(502, "Google Drive did not confirm the document sync");
        }
        return await db.orm.public.Document
            .where({ id: document.id })
            .select("id", "adminGoogleDriveFileId", "adminGoogleDriveFolderId", "adminDriveSyncStatus")
            .update({
            adminGoogleDriveFileId: googleDriveFileId,
            adminGoogleDriveFolderId: parentFolderId,
            adminDriveSyncStatus: "SYNCED",
        });
    }
    catch (error) {
        await db.orm.public.Document
            .where({ id: document.id })
            .update({ adminDriveSyncStatus: "FAILED" });
        throw error;
    }
}
async function getAdminDriveContext() {
    if (!env.adminEmail)
        return null;
    const admin = await db.orm.public.User
        .select("id", "role", "isActive")
        .where({ email: env.adminEmail })
        .first();
    if (!admin || admin.role !== "ADMIN" || !admin.isActive)
        return null;
    const connection = await db.orm.public.AdminGoogleDriveConnection
        .where({ adminId: admin.id })
        .first();
    if (!connection || connection.status === "DISCONNECTED")
        return null;
    return getConnectedAdminDriveClient(admin.id);
}
async function getOrCreateSyncRoot(context) {
    if (context.connection.syncRootFolderId) {
        return context.connection.syncRootFolderId;
    }
    const existing = await context.drive.files.list({
        q: "appProperties has { key='smartdocAdminRoot' and value='true' } and trashed = false",
        spaces: "drive",
        pageSize: 1,
        fields: "files(id)",
    });
    let rootFolderId = existing.data.files?.[0]?.id;
    if (!rootFolderId) {
        const response = await context.drive.files.create({
            requestBody: {
                name: "SmartDoc",
                mimeType: googleFolderMimeType,
                appProperties: { smartdocAdminRoot: "true" },
            },
            fields: "id",
        });
        rootFolderId = response.data.id ?? undefined;
    }
    if (!rootFolderId) {
        throw new HttpError(502, "Google Drive did not confirm the SmartDoc folder");
    }
    await db.orm.public.AdminGoogleDriveConnection
        .where({ id: context.connection.id })
        .update({ syncRootFolderId: rootFolderId });
    return rootFolderId;
}
