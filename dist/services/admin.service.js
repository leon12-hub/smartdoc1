import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../utils/httpError.js";
import { env } from "../config/env.js";
import { writeAdminLog } from "./adminLog.service.js";
export async function getDashboard() {
    const startOfToday = Temporal.Instant.from(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const [users, documents, todayUploads, recentActivity, connectedDriveAccounts, syncedDriveDocuments, failedDriveUploads, pendingAnalysis, failedAnalysis, adminDriveSyncedDocuments, adminDriveSyncedFolders, adminDriveFailedDocuments, adminDriveFailedFolders] = await Promise.all([
        db.orm.public.User.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where((document) => document.createdAt.gte(startOfToday))
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.AdminLog
            .select("id", "action", "resourceType", "resourceId", "adminId", "createdAt")
            .orderBy((log) => log.createdAt.desc())
            .limit(10)
            .all(),
        db.orm.public.GoogleDriveConnection
            .where({ status: "CONNECTED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ driveSyncStatus: "SYNCED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ driveSyncStatus: "FAILED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ analysisStatus: "PENDING" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ analysisStatus: "FAILED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ adminDriveSyncStatus: "SYNCED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Folder
            .where({ adminDriveSyncStatus: "SYNCED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document
            .where({ adminDriveSyncStatus: "FAILED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Folder
            .where({ adminDriveSyncStatus: "FAILED" })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
    ]);
    return {
        statistics: {
            totalUsers: users.total,
            totalDocuments: documents.total,
            todaysUploads: todayUploads.total,
            connectedDriveAccounts: connectedDriveAccounts.total,
            syncedDriveDocuments: syncedDriveDocuments.total,
            failedDriveUploads: failedDriveUploads.total,
            pendingDocumentAnalysis: pendingAnalysis.total,
            failedDocumentAnalysis: failedAnalysis.total,
            adminDriveSyncedDocuments: adminDriveSyncedDocuments.total,
            adminDriveSyncedFolders: adminDriveSyncedFolders.total,
            adminDriveSyncFailures: adminDriveFailedDocuments.total + adminDriveFailedFolders.total,
            systemStatus: "healthy",
        },
        recentActivity,
        quickActions: ["create-folder", "documents", "upload", "scan"],
    };
}
export async function listAdminUsers(limit) {
    return db.orm.public.User
        .select("id", "name", "email", "role", "isActive", "createdAt", "updatedAt")
        .orderBy((user) => user.createdAt.desc())
        .limit(limit)
        .all();
}
export async function setAdminUserActive(actingAdminId, userId, isActive) {
    if (actingAdminId === userId && !isActive) {
        throw new HttpError(400, "You cannot deactivate your own administrator account");
    }
    const user = await db.orm.public.User
        .where({ id: userId })
        .select("id", "name", "email", "role", "isActive")
        .first();
    if (!user) {
        throw new HttpError(404, "User not found");
    }
    const updated = await db.orm.public.User
        .where({ id: userId })
        .select("id", "name", "email", "role", "isActive", "updatedAt")
        .update({ isActive });
    await writeAdminLog(actingAdminId, "admin.user.status_changed", "user", userId);
    return updated;
}
export async function listAdminDocuments(limit) {
    return db.orm.public.Document
        .select("id", "name", "fileType", "fileSize", "status", "analysisStatus", "driveSyncStatus", "adminDriveSyncStatus", "googleDriveFileId", "adminGoogleDriveFileId", "userId", "folderId", "createdAt")
        .orderBy((document) => document.createdAt.desc())
        .limit(limit)
        .all();
}
export async function getReports() {
    const [users, documents, activeUsers, scannedDocuments, completedAnalysis, failedAnalysis, pendingAnalysis, syncedDocuments] = await Promise.all([
        db.orm.public.User.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Document.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.User.where({ isActive: true }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
        db.orm.public.Document.where({ source: "SCAN" }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
        db.orm.public.Document.where({ analysisStatus: "COMPLETE" }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
        db.orm.public.Document.where({ analysisStatus: "FAILED" }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
        db.orm.public.Document.where({ analysisStatus: "PENDING" }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
        db.orm.public.Document.where({ driveSyncStatus: "SYNCED" }).aggregate((aggregate) => ({
            total: aggregate.count(),
        })),
    ]);
    return {
        totalUsers: users.total,
        activeUsers: activeUsers.total,
        totalDocuments: documents.total,
        scannedDocuments: scannedDocuments.total,
        completedDocumentAnalysis: completedAnalysis.total,
        failedDocumentAnalysis: failedAnalysis.total,
        pendingDocumentAnalysis: pendingAnalysis.total,
        documentsSyncedToDrive: syncedDocuments.total,
        generatedAt: new Date().toISOString(),
    };
}
export async function listAdminLogs(limit) {
    return db.orm.public.AdminLog
        .select("id", "action", "resourceType", "resourceId", "adminId", "createdAt")
        .orderBy((log) => log.createdAt.desc())
        .limit(limit)
        .all();
}
export async function getAdminSettings() {
    return {
        service: "SmartDoc Backend",
        status: "healthy",
        authentication: "JWT",
        googleDriveConfigured: Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri &&
            env.googleTokenEncryptionKey),
        geminiConfigured: Boolean(env.geminiApiKey),
        automaticDocumentAnalysis: false,
        geminiModel: env.geminiModel,
    };
}
export function parseLimit(value) {
    if (value === undefined) {
        return 100;
    }
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, "limit must be an integer between 1 and 100");
    }
    return limit;
}
