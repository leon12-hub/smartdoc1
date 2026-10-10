import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { anonymousCookieName, readCookie, setAuthCookie } from "../utils/cookies.js";
import { HttpError } from "../utils/httpError.js";
import { createAnonymousToken, anonymousTokenMatches, hashAnonymousToken, verifyAnonymousToken, } from "../utils/jwt.js";
import { disconnectGoogleDrive } from "./google/googleDrive.service.js";
import { removeTemporaryFile, restoreStagedFile, stageStoredFileForDeletion, } from "../utils/uploadStorage.js";
const anonymousSessionLifetimeSeconds = 31_536_000;
export async function createAnonymousSession(req, res) {
    const existingToken = req.get("x-anonymous-session") ?? readCookie(req, anonymousCookieName);
    if (existingToken) {
        const sessionId = verifyAnonymousToken(existingToken);
        if (!sessionId) {
            throw new HttpError(401, "Anonymous session is invalid or expired");
        }
        const session = await db.orm.public.AnonymousSession.first({ id: sessionId });
        if (!session ||
            !anonymousTokenMatches(existingToken, session.tokenHash) ||
            session.revokedAt !== null ||
            Temporal.Instant.compare(session.expiresAt, Temporal.Now.instant()) <= 0) {
            throw new HttpError(401, "Anonymous session is invalid, expired, or revoked");
        }
        setAuthCookie(res, anonymousCookieName, existingToken, anonymousSessionLifetimeSeconds);
        return { token: existingToken, sessionId };
    }
    const session = createAnonymousToken();
    const now = Temporal.Now.instant();
    await db.orm.public.AnonymousSession.create({
        id: session.sessionId,
        tokenHash: hashAnonymousToken(session.token),
        expiresAt: now.add({ seconds: anonymousSessionLifetimeSeconds }),
        revokedAt: null,
    });
    setAuthCookie(res, anonymousCookieName, session.token, anonymousSessionLifetimeSeconds);
    return session;
}
export async function getAnonymousSession(sessionId) {
    const session = await db.orm.public.AnonymousSession
        .select("id", "createdAt", "expiresAt")
        .where({ id: sessionId })
        .first();
    if (!session) {
        throw new HttpError(401, "Anonymous session is no longer available");
    }
    const [documents, folders] = await Promise.all([
        db.orm.public.Document
            .where({ ownerSessionId: sessionId, userId: null })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Folder
            .where({ ownerSessionId: sessionId, userId: null })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
    ]);
    return {
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        documentCount: documents.total,
        folderCount: folders.total,
    };
}
export async function deleteAnonymousSession(sessionId) {
    const documents = await db.orm.public.Document
        .select("storagePath")
        .where({ ownerSessionId: sessionId, userId: null })
        .all();
    const stagedFiles = [];
    try {
        for (const document of documents) {
            if (!document.storagePath)
                continue;
            const temporaryPath = await stageStoredFileForDeletion(document.storagePath);
            if (temporaryPath) {
                stagedFiles.push({ storagePath: document.storagePath, temporaryPath });
            }
        }
        await disconnectGoogleDrive(sessionId);
        await db.orm.public.AnonymousSession.where({ id: sessionId }).delete();
    }
    catch (error) {
        for (const file of stagedFiles.reverse()) {
            await restoreStagedFile(file.storagePath, file.temporaryPath);
        }
        throw error;
    }
    for (const file of stagedFiles) {
        await removeTemporaryFile(file.temporaryPath);
    }
}
