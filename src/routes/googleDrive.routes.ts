import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAnonymousSession } from "../middleware/anonymousSession.middleware.js";
import { singleDocumentUpload } from "../middleware/upload.middleware.js";
import {
  createGoogleDriveFolder,
  disconnectGoogleDrive,
  getDriveConnectionStatus,
  listGoogleDriveFolders,
  syncGuestDocumentToDrive,
} from "../services/google/googleDrive.service.js";
import {
  beginGoogleDriveConnection,
  consumeGoogleOAuthState,
  finishGoogleDriveConnection,
  getOAuthReturnUrl,
} from "../services/google/googleOAuth.service.js";
import {
  consumeAdminGoogleOAuthState,
  consumeAdminGoogleLoginState,
  finishAdminGoogleLogin,
  finishAdminGoogleDriveConnection,
  getAdminGoogleLoginReturnUrl,
  getAdminMobileLoginReturnUrl,
  getAdminOAuthReturnUrl,
} from "../services/google/adminGoogleOAuth.service.js";
import { storeGuestUpload } from "../services/upload.service.js";
import {
  adminCookieName,
  anonymousCookieName,
  readCookie,
  setAuthCookie,
} from "../utils/cookies.js";
import { HttpError } from "../utils/httpError.js";
import { parseId, requireObjectBody, requireSessionResponseContext } from "../utils/requestValidation.js";
import { getAdminTokenDurationSeconds, verifyAnonymousToken } from "../utils/jwt.js";
import { removeTemporaryFile } from "../utils/uploadStorage.js";

export const googleDriveRouter = Router();

const oauthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many Google Drive authorization attempts. Please try again later." },
});

googleDriveRouter.get("/callback", oauthRateLimit, async (req, res) => {
  const state = singleQueryValue(req.query.state);
  if (!state) {
    throw new HttpError(400, "Google Drive authorization state is required");
  }
  const adminContext = await consumeAdminGoogleOAuthState(state);
  if (adminContext) {
    const providerError = singleQueryValue(req.query.error);
    if (providerError) {
      console.info(JSON.stringify({
        event: "admin_google_drive_oauth_cancelled",
        adminId: adminContext.adminId,
      }));
      res.redirect(303, getAdminOAuthReturnUrl("cancelled"));
      return;
    }
    const code = singleQueryValue(req.query.code);
    if (!code) throw new HttpError(400, "Google authorization code is required");
    try {
      await finishAdminGoogleDriveConnection(adminContext.adminId, code);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "admin_google_drive_oauth_failed",
        adminId: adminContext.adminId,
        reason: error instanceof Error ? error.message : "callback_processing_failed",
      }));
      res.redirect(303, getAdminOAuthReturnUrl("failed"));
      return;
    }
    res.redirect(303, getAdminOAuthReturnUrl("connected"));
    return;
  }
  const loginContext = await consumeAdminGoogleLoginState(state);
  if (loginContext) {
    const providerError = singleQueryValue(req.query.error);
    if (providerError) {
      const destination = loginContext.channel === "MOBILE"
        ? getAdminMobileLoginReturnUrl({ status: "cancelled" })
        : getAdminGoogleLoginReturnUrl("cancelled", loginContext.returnUri);
      res.redirect(303, destination);
      return;
    }
    const code = singleQueryValue(req.query.code);
    if (!code) throw new HttpError(400, "Google authorization code is required");
    try {
      const result = await finishAdminGoogleLogin(
        loginContext.id,
        loginContext.channel,
        code,
      );
      if (loginContext.channel === "MOBILE") {
        if (!result.completionCode) throw new Error("Mobile completion code was not created");
        res.redirect(303, getAdminMobileLoginReturnUrl({ code: result.completionCode }));
        return;
      }
      if (!result.token) throw new Error("Web admin session was not created");
      setAuthCookie(res, adminCookieName, result.token, getAdminTokenDurationSeconds());
      res.redirect(303, getAdminGoogleLoginReturnUrl("connected", loginContext.returnUri));
      return;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "admin_google_login_failed",
        reason: error instanceof Error ? error.message : "callback_processing_failed",
      }));
      const destination = loginContext.channel === "MOBILE"
        ? getAdminMobileLoginReturnUrl({ status: "failed" })
        : getAdminGoogleLoginReturnUrl("failed", loginContext.returnUri);
      res.redirect(303, destination);
      return;
    }
  }
  const cookie = readCookie(req, anonymousCookieName);
  const cookieSessionId = cookie ? verifyAnonymousToken(cookie) ?? undefined : undefined;
  if (cookie && !cookieSessionId) {
    throw new HttpError(400, "Google Drive authorization session is invalid");
  }
  const anonymousSessionId = await consumeGoogleOAuthState(state, cookieSessionId);
  const providerError = singleQueryValue(req.query.error);
  if (providerError) {
    console.info(
      JSON.stringify({
        event: "google_drive_oauth_cancelled",
        anonymousSessionId,
      }),
    );
    res.redirect(303, getOAuthReturnUrl("cancelled"));
    return;
  }
  const code = singleQueryValue(req.query.code);
  if (!code) {
    throw new HttpError(400, "Google authorization code is required");
  }
  try {
    await finishGoogleDriveConnection(anonymousSessionId, code);
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) {
      res.redirect(303, getOAuthReturnUrl("failed"));
      return;
    }
    console.warn(
      JSON.stringify({
        event: "google_drive_oauth_failed",
        anonymousSessionId,
        reason: "callback_processing_failed",
      }),
    );
    res.redirect(303, getOAuthReturnUrl("failed"));
    return;
  }
  res.redirect(303, getOAuthReturnUrl("connected"));
});

googleDriveRouter.get("/connect", requireAnonymousSession, oauthRateLimit, async (_req, res) => {
  const authorizationUrl = await beginGoogleDriveConnection(
    requireSessionResponseContext(res),
  );
  res.json({ success: true, authorizationUrl });
});

googleDriveRouter.post("/reconnect", requireAnonymousSession, oauthRateLimit, async (_req, res) => {
  const authorizationUrl = await beginGoogleDriveConnection(
    requireSessionResponseContext(res),
    "select_account",
  );
  res.json({ success: true, authorizationUrl });
});

googleDriveRouter.get("/status", requireAnonymousSession, async (_req, res) => {
  res.json({
    success: true,
    ...(await getDriveConnectionStatus(requireSessionResponseContext(res))),
  });
});

googleDriveRouter.post("/disconnect", requireAnonymousSession, async (_req, res) => {
  await disconnectGoogleDrive(requireSessionResponseContext(res));
  res.json({ success: true, connected: false });
});

googleDriveRouter.get("/folders", requireAnonymousSession, async (req, res) => {
  const parentFolderId = singleQueryValue(req.query.parentFolderId);
  const pageToken = singleQueryValue(req.query.pageToken);
  if (pageToken && pageToken.length > 2048) {
    throw new HttpError(400, "pageToken is too long");
  }
  res.json({
    success: true,
    ...(await listGoogleDriveFolders(requireSessionResponseContext(res), {
      ...(parentFolderId ? { parentFolderId } : {}),
      ...(pageToken ? { pageToken } : {}),
    })),
  });
});

googleDriveRouter.post("/folders", requireAnonymousSession, async (req, res) => {
  const body = requireObjectBody(req.body);
  const folder = await createGoogleDriveFolder(
    requireSessionResponseContext(res),
    body.name,
    body.parentFolderId,
  );
  res.status(201).json({ success: true, folder });
});

googleDriveRouter.post(
  "/upload",
  requireAnonymousSession,
  singleDocumentUpload.single("file"),
  async (req, res) => {
    const sessionId = requireSessionResponseContext(res);
    const body = requireObjectBody(req.body);
    const documentIdValue = body.documentId;
    if (req.file && documentIdValue !== undefined) {
      await removeTemporaryFile(req.file.path);
      throw new HttpError(400, "Provide either a local documentId or a file, not both");
    }
    let documentId: string;
    let createdLocally = false;
    if (documentIdValue !== undefined) {
      if (typeof documentIdValue !== "string") {
        if (req.file) await removeTemporaryFile(req.file.path);
        throw new HttpError(400, "documentId must be a string");
      }
      documentId = parseId(documentIdValue);
    } else {
      if (!req.file) {
        throw new HttpError(400, "A local documentId or a file is required");
      }
      const document = await storeGuestUpload(
        sessionId,
        { ...(typeof body.name === "string" ? { name: body.name } : {}) },
        req.file,
      );
      documentId = document.id;
      createdLocally = true;
    }

    try {
      const document = await syncGuestDocumentToDrive(
        sessionId,
        documentId,
        body.folderId,
      );
      res.status(createdLocally ? 201 : 200).json({
        success: true,
        document,
        localSaved: true,
      });
    } catch (error) {
      if (createdLocally) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError
          ? error.message
          : "Document was saved locally, but Google Drive synchronization failed";
        res.status(status).json({
          success: false,
          message,
          localSaved: true,
          document: { id: documentId },
        });
        return;
      }
      throw error;
    }
  },
);

function singleQueryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "Query parameters must be provided once");
  }
  return value;
}
