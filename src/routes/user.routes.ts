import { Router } from "express";
import { requireAnonymousSession } from "../middleware/anonymousSession.middleware.js";
import { registerDeviceUser } from "../services/deviceUser.service.js";
import { HttpError } from "../utils/httpError.js";
import { requireObjectBody, requireSessionResponseContext } from "../utils/requestValidation.js";

export const userRouter = Router();

userRouter.post("/register-device", requireAnonymousSession, async (req, res) => {
  const body = requireObjectBody(req.body);
  const name = typeof body.name === "string" ? body.name : undefined;
  const result = await registerDeviceUser(requireSessionResponseContext(res), name);
  res.status(201).json({ success: true, ...result });
});

userRouter.get("/drive-folder", requireAnonymousSession, async (_req, res) => {
  const anonymousSessionId = requireSessionResponseContext(res);
  const result = await registerDeviceUser(anonymousSessionId, undefined);
  res.json({ success: true, ...result });
});

userRouter.post("/register", requireAnonymousSession, async (req, res) => {
  const body = requireObjectBody(req.body);
  const name = typeof body.name === "string" ? body.name : undefined;
  if (body.name !== undefined && typeof body.name !== "string") {
    throw new HttpError(400, "name must be a string when provided");
  }
  const result = await registerDeviceUser(requireSessionResponseContext(res), name);
  res.status(201).json({ success: true, ...result });
});
