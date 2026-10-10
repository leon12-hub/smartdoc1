import type { RequestHandler } from "express";
import { db } from "../prisma/db.js";
import { adminCookieName, readCookie } from "../utils/cookies.js";
import { HttpError } from "../utils/httpError.js";
import { verifyAccessToken } from "../utils/jwt.js";

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const authorization = req.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? readCookie(req, adminCookieName);
  if (!token) {
    next(new HttpError(401, "Administrator authentication is required"));
    return;
  }

  const tokenUser = verifyAccessToken(token);
  if (!tokenUser) {
    next(new HttpError(401, "Administrator token is invalid or expired"));
    return;
  }
  if (tokenUser.role !== "ADMIN") {
    next(new HttpError(403, "Administrator access is forbidden"));
    return;
  }

  const admin = await db.orm.public.User
    .select("id", "name", "email", "role", "isActive")
    .first({ id: tokenUser.id });

  if (!admin) {
    next(new HttpError(401, "Administrator account no longer exists"));
    return;
  }
  if (admin.role !== "ADMIN" || !admin.isActive) {
    next(new HttpError(403, "Administrator access is forbidden"));
    return;
  }

  if (!tokenUser.sessionId) {
    next(new HttpError(401, "Administrator session is invalid"));
    return;
  }
  const session = await db.orm.public.AdminSession.first({ id: tokenUser.sessionId });
  if (!session || session.adminId !== admin.id || session.revokedAt !== null) {
    next(new HttpError(401, "Administrator session is invalid or has been revoked"));
    return;
  }

  res.locals.admin = { id: admin.id, name: admin.name, email: admin.email };
  res.locals.adminSessionId = session.id;
  next();
};
