import jwt, { type JwtPayload } from "jsonwebtoken";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { env, parseDurationSeconds } from "../config/env.js";

const issuer = "smartdoc-api";

export interface AdminToken {
  id: string;
  email: string;
  name: string;
}

export interface AccessToken {
  id: string;
  role: "USER" | "ADMIN";
  sessionId?: string;
  email?: string;
  name?: string;
}

export function getAdminTokenDurationSeconds(): number {
  return parseDurationSeconds(env.jwtExpiresIn);
}

export function createAnonymousToken(): { token: string; sessionId: string } {
  const sessionId = randomUUID();
  const token = jwt.sign({ typ: "anonymous" }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: 31_536_000,
    issuer,
    subject: sessionId,
  });

  return { token, sessionId };
}

export function hashAnonymousToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function anonymousTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashAnonymousToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyAnonymousToken(token: string): string | null {
  const payload = verifyToken(token);
  return payload?.typ === "anonymous" && typeof payload.sub === "string" ? payload.sub : null;
}

export function createAdminToken(admin: AdminToken): { token: string; sessionId: string } {
  const sessionId = randomUUID();
  const token = jwt.sign(
    { typ: "admin", role: "ADMIN", email: admin.email, name: admin.name },
    env.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: getAdminTokenDurationSeconds(),
      issuer,
      subject: admin.id,
      jwtid: sessionId,
    },
  );
  return { token, sessionId };
}

export function verifyAdminToken(token: string): AdminToken | null {
  const payload = verifyAccessToken(token);
  if (payload?.role !== "ADMIN" || !payload.email || !payload.name || !payload.sessionId) {
    return null;
  }

  return { id: payload.id, email: payload.email, name: payload.name };
}

export function verifyAccessToken(token: string): AccessToken | null {
  const payload = verifyToken(token);
  if (
    !payload ||
    typeof payload.sub !== "string" ||
    (payload.role !== "USER" && payload.role !== "ADMIN")
  ) {
    return null;
  }
  if (payload.role === "ADMIN" && payload.typ !== "admin") {
    return null;
  }
  if (payload.role === "USER" && payload.typ !== undefined && payload.typ !== "user") {
    return null;
  }

  if (payload.role === "ADMIN" && typeof payload.jti !== "string") {
    return null;
  }

  return {
    id: payload.sub,
    role: payload.role,
    ...(typeof payload.jti === "string" ? { sessionId: payload.jti } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
  };
}

function verifyToken(
  token: string,
): (JwtPayload & { typ?: unknown; role?: unknown; email?: unknown; name?: unknown }) | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ["HS256"],
      issuer,
    });
    return typeof payload === "string" ? null : payload;
  } catch (error) {
    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.TokenExpiredError ||
      error instanceof jwt.NotBeforeError
    ) {
      return null;
    }

    throw error;
  }
}
