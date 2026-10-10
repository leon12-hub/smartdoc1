import type { RequestHandler } from "express";
import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../utils/httpError.js";
import { anonymousCookieName, readCookie } from "../utils/cookies.js";
import { anonymousTokenMatches, verifyAnonymousToken } from "../utils/jwt.js";

export const requireAnonymousSession: RequestHandler = async (req, res, next) => {
  const token = req.get("x-anonymous-session") ?? readCookie(req, anonymousCookieName);
  if (!token) {
    next(new HttpError(401, "Create an anonymous session before managing documents"));
    return;
  }

  const sessionId = verifyAnonymousToken(token);
  if (!sessionId) {
    next(new HttpError(401, "Anonymous session is invalid or expired"));
    return;
  }

  const session = await db.orm.public.AnonymousSession.first({ id: sessionId });
  if (
    !session ||
    !anonymousTokenMatches(token, session.tokenHash) ||
    session.revokedAt !== null ||
    Temporal.Instant.compare(session.expiresAt, Temporal.Now.instant()) <= 0
  ) {
    next(new HttpError(401, "Anonymous session is invalid, expired, or revoked"));
    return;
  }

  res.locals.anonymousSessionId = sessionId;
  next();
};
