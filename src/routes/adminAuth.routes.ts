import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import {
  beginAdminGoogleLogin,
  consumeAdminGoogleLoginCompletion,
} from "../services/google/adminGoogleOAuth.service.js";
import { logoutAdmin } from "../services/adminAuth.service.js";
import { adminCookieName, clearAuthCookie, setAuthCookie } from "../utils/cookies.js";
import { getAdminTokenDurationSeconds } from "../utils/jwt.js";
import { requireAdminSessionId } from "../utils/requestValidation.js";
import { HttpError } from "../utils/httpError.js";
import rateLimit from "express-rate-limit";

export const adminAuthRouter = Router();

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many administrator login attempts. Please try again later." },
});

adminAuthRouter.post("/google/start", loginRateLimit, async (req, res) => {
  const channel = req.body?.channel;
  if (channel !== "web" && channel !== "mobile") {
    throw new HttpError(400, "Google sign-in channel must be web or mobile");
  }
  const authorizationUrl = await beginAdminGoogleLogin(channel, req.body?.returnUri);
  res.json({ success: true, authorizationUrl });
});

adminAuthRouter.post("/google/complete", loginRateLimit, async (req, res) => {
  const result = await consumeAdminGoogleLoginCompletion(req.body?.code);
  setAuthCookie(res, adminCookieName, result.token, getAdminTokenDurationSeconds());
  res.json({
    success: true,
    message: "Google admin sign-in successful",
    admin: result.admin,
    token: result.token,
  });
});

adminAuthRouter.get("/me", requireAdmin, (_req, res) => {
  res.json({ success: true, admin: res.locals.admin });
});

adminAuthRouter.post("/logout", requireAdmin, async (_req, res) => {
  await logoutAdmin(
    requireAdminSessionId(res.locals.adminSessionId),
    requireAdminSessionId(res.locals.admin?.id),
  );
  clearAuthCookie(res, adminCookieName);
  res.json({ success: true, message: "Admin logged out" });
});
