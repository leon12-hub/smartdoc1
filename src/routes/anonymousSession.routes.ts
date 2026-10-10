import { Router } from "express";
import { requireAnonymousSession } from "../middleware/anonymousSession.middleware.js";
import {
  createAnonymousSession,
  deleteAnonymousSession,
  getAnonymousSession,
} from "../services/anonymousSession.service.js";
import { anonymousCookieName, clearAuthCookie } from "../utils/cookies.js";
import { requireSessionResponseContext } from "../utils/requestValidation.js";

export const anonymousSessionRouter = Router();

anonymousSessionRouter.post("/", async (req, res) => {
  const session = await createAnonymousSession(req, res);
  res.json({ success: true, anonymousSessionId: session.token });
});

anonymousSessionRouter.post("/cookie", async (req, res) => {
  await createAnonymousSession(req, res);
  res.json({ success: true });
});

anonymousSessionRouter.get("/", requireAnonymousSession, async (_req, res) => {
  res.json({
    success: true,
    session: await getAnonymousSession(requireSessionResponseContext(res)),
  });
});

anonymousSessionRouter.delete("/", requireAnonymousSession, async (_req, res) => {
  await deleteAnonymousSession(requireSessionResponseContext(res));
  clearAuthCookie(res, anonymousCookieName);
  res.json({
    success: true,
    message: "SmartDoc session and local documents were permanently deleted. Google Drive copies were left unchanged.",
  });
});
