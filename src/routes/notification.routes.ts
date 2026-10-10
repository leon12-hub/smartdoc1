import { Router } from "express";
import { requireAnonymousSession } from "../middleware/anonymousSession.middleware.js";
import {
  listGuestNotifications,
  markGuestNotificationRead,
} from "../services/notification.service.js";
import {
  parseId,
  requireSessionResponseContext,
} from "../utils/requestValidation.js";

export const notificationRouter = Router();

notificationRouter.get("/", requireAnonymousSession, async (_req, res) => {
  res.json({
    success: true,
    ...(await listGuestNotifications(requireSessionResponseContext(res))),
  });
});

notificationRouter.post("/:id/read", requireAnonymousSession, async (req, res) => {
  await markGuestNotificationRead(
    requireSessionResponseContext(res),
    parseId(req.params.id),
  );
  res.json({ success: true });
});
