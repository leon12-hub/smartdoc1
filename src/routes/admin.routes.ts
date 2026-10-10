import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getAdminSettings,
  getDashboard,
  getReports,
  listAdminDocuments,
  listAdminLogs,
  listAdminUsers,
  parseLimit,
  setAdminUserActive,
} from "../services/admin.service.js";
import {
  beginAdminGoogleDriveConnection,
  disconnectAdminGoogleDrive,
  getAdminGoogleDriveStatus,
} from "../services/google/adminGoogleOAuth.service.js";
import { parseId, requireAdminSessionId, requireObjectBody } from "../utils/requestValidation.js";
import { HttpError } from "../utils/httpError.js";

export const adminRouter = Router();

const googleOAuthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many Google Drive authorization attempts. Please try again later." },
});

adminRouter.get("/google/drive/status", async (_req, res) => {
  const adminId = res.locals.admin?.id;
  if (typeof adminId !== "string") throw new HttpError(401, "Administrator context is missing");
  res.json({ success: true, ...(await getAdminGoogleDriveStatus(adminId)) });
});

adminRouter.post("/google/drive/connect", googleOAuthRateLimit, async (_req, res) => {
  const adminId = res.locals.admin?.id;
  if (typeof adminId !== "string") throw new HttpError(401, "Administrator context is missing");
  const authorizationUrl = await beginAdminGoogleDriveConnection(
    adminId,
    requireAdminSessionId(res.locals.adminSessionId),
  );
  res.json({ success: true, authorizationUrl });
});

adminRouter.post("/google/drive/reconnect", googleOAuthRateLimit, async (_req, res) => {
  const adminId = res.locals.admin?.id;
  if (typeof adminId !== "string") throw new HttpError(401, "Administrator context is missing");
  const authorizationUrl = await beginAdminGoogleDriveConnection(
    adminId,
    requireAdminSessionId(res.locals.adminSessionId),
    "select_account",
  );
  res.json({ success: true, authorizationUrl });
});

adminRouter.post("/google/drive/disconnect", async (_req, res) => {
  const adminId = res.locals.admin?.id;
  if (typeof adminId !== "string") throw new HttpError(401, "Administrator context is missing");
  await disconnectAdminGoogleDrive(adminId);
  res.json({ success: true, connected: false });
});

adminRouter.patch("/users/:id", async (req, res) => {
  const body = requireObjectBody(req.body);
  if (Object.keys(body).length !== 1 || typeof body.isActive !== "boolean") {
    throw new HttpError(400, "Request body must contain only a boolean isActive field");
  }
  const adminId = res.locals.admin?.id;
  if (typeof adminId !== "string") {
    throw new HttpError(401, "Administrator context is missing");
  }
  const user = await setAdminUserActive(adminId, parseId(req.params.id), body.isActive);
  res.json({ success: true, user });
});

adminRouter.get("/dashboard", async (_req, res) => {
  res.json({ success: true, ...(await getDashboard()) });
});

adminRouter.get("/users", async (req, res) => {
  res.json({ success: true, users: await listAdminUsers(parseLimit(req.query.limit)) });
});

adminRouter.get("/documents", async (req, res) => {
  res.json({ success: true, documents: await listAdminDocuments(parseLimit(req.query.limit)) });
});

adminRouter.get("/reports", async (_req, res) => {
  res.json({ success: true, reports: await getReports() });
});

adminRouter.get("/logs", async (req, res) => {
  res.json({ success: true, logs: await listAdminLogs(parseLimit(req.query.limit)) });
});

adminRouter.get("/settings", (_req, res) => {
  res.json({ success: true, settings: getAdminSettings() });
});
