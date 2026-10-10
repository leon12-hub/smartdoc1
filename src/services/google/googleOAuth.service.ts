import { createHash, randomBytes, randomUUID } from "node:crypto";
import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { Temporal } from "temporal-polyfill";
import { env } from "../../config/env.js";
import { db } from "../../prisma/db.js";
import { HttpError } from "../../utils/httpError.js";
import {
  createOAuthClient,
  googleDriveScope,
  googleProfileScopes,
  requireGoogleConfiguration,
  validateOAuthReturnUri,
} from "./googleConfig.js";
import {
  encryptRefreshToken,
  isInvalidGrant,
} from "./googleToken.service.js";

const oauthStateLifetimeSeconds = 600;

export async function beginGoogleDriveConnection(
  anonymousSessionId: string,
  prompt: "consent" | "select_account" = "consent",
): Promise<string> {
  requireGoogleConfiguration();
  const now = Temporal.Now.instant();
  await db.orm.public.GoogleOAuthState
    .where((state) => state.expiresAt.lt(now))
    .delete();

  const state = randomBytes(32).toString("base64url");
  const stateId = createHash("sha256").update(state).digest("hex");
  await db.orm.public.GoogleOAuthState.create({
    id: stateId,
    anonymousSessionId,
    expiresAt: now.add({ seconds: oauthStateLifetimeSeconds }),
    consumedBy: null,
  });

  const oauth = createOAuthClient();
  const authorizationUrl = oauth.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt,
    state,
    scope: [googleDriveScope, ...googleProfileScopes],
  });
  console.info(
    JSON.stringify({
      event: "google_drive_oauth_started",
      anonymousSessionId,
    }),
  );
  return authorizationUrl;
}

export async function consumeGoogleOAuthState(
  state: string,
  cookieSessionId?: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new HttpError(400, "Google Drive authorization state is invalid");
  }
  const stateId = createHash("sha256").update(state).digest("hex");
  const record = await db.orm.public.GoogleOAuthState.where({ id: stateId }).first();
  if (!record) {
    throw new HttpError(400, "Google Drive authorization state is invalid or already used");
  }
  if (record.consumedBy !== null) {
    throw new HttpError(400, "Google Drive authorization state has already been used");
  }
  if (Temporal.Instant.compare(record.expiresAt, Temporal.Now.instant()) <= 0) {
    throw new HttpError(400, "Google Drive authorization state has expired");
  }
  if (cookieSessionId && record.anonymousSessionId !== cookieSessionId) {
    throw new HttpError(400, "Google Drive authorization state does not match this session");
  }

  const claimId = randomUUID();
  await db.orm.public.GoogleOAuthState
    .where({ id: stateId, consumedBy: null })
    .update({ consumedBy: claimId });
  const claimed = await db.orm.public.GoogleOAuthState
    .where({ id: stateId, consumedBy: claimId })
    .first();
  if (!claimed) {
    throw new HttpError(400, "Google Drive authorization state has already been used");
  }
  const session = await db.orm.public.AnonymousSession
    .where({ id: claimed.anonymousSessionId })
    .first();
  if (
    !session ||
    session.revokedAt !== null ||
    Temporal.Instant.compare(session.expiresAt, Temporal.Now.instant()) <= 0
  ) {
    throw new HttpError(401, "The SmartDoc guest session has expired");
  }
  return claimed.anonymousSessionId;
}

export async function finishGoogleDriveConnection(
  anonymousSessionId: string,
  authorizationCode: string,
): Promise<void> {
  requireGoogleConfiguration();
  if (!authorizationCode || authorizationCode.length > 4096) {
    throw new HttpError(400, "Google authorization code is invalid");
  }
  const oauth = createOAuthClient();
  let tokens: Credentials;
  try {
    tokens = (await oauth.getToken(authorizationCode)).tokens;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "google_drive_oauth_failed",
        anonymousSessionId,
        reason: isInvalidGrant(error) ? "authorization_code_rejected" : "token_exchange_failed",
      }),
    );
    throw new HttpError(
      400,
      "Google Drive authorization could not be completed. Please reconnect.",
    );
  }
  oauth.setCredentials(tokens);

  let account: { id?: string | null; email?: string | null; verified_email?: boolean | null };
  try {
    const result = await google
      .oauth2({ version: "v2", auth: oauth })
      .userinfo.get();
    account = result.data;
  } catch {
    throw new HttpError(502, "Could not verify the authorized Google account");
  }
  if (!account.id || account.verified_email === false) {
    throw new HttpError(502, "Google did not provide a verified account");
  }

  const existing = await db.orm.public.GoogleDriveConnection
    .where({ anonymousSessionId })
    .first();
  const scopes = tokens.scope ?? existing?.scopes ?? "";
  if (!scopes.split(/\s+/).includes(googleDriveScope)) {
    throw new HttpError(
      403,
      "Google Drive did not grant the required file access permission.",
    );
  }
  let encryptedRefreshToken = existing?.encryptedRefreshToken ?? "";
  if (tokens.refresh_token) {
    encryptedRefreshToken = encryptRefreshToken(tokens.refresh_token);
  } else if (
    !existing ||
    existing.status === "DISCONNECTED" ||
    existing.googleAccountId !== account.id ||
    !encryptedRefreshToken
  ) {
    throw new HttpError(
      400,
      "Google did not provide a refresh token. Revoke SmartDoc access in Google Account settings and connect again.",
    );
  }

  const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  if (existing) {
    await db.orm.public.GoogleDriveConnection
      .where({ id: existing.id })
      .update({
        googleAccountId: account.id,
        googleEmail: account.email ?? null,
        encryptedRefreshToken,
        scopes,
        accessTokenExpiresAt: tokenExpiry,
        status: "CONNECTED",
        disconnectedAt: null,
      });
  } else {
    await db.orm.public.GoogleDriveConnection.create({
      anonymousSessionId,
      googleAccountId: account.id,
      googleEmail: account.email ?? null,
      encryptedRefreshToken,
      scopes,
      accessTokenExpiresAt: tokenExpiry,
      status: "CONNECTED",
      disconnectedAt: null,
    });
  }
  console.info(
    JSON.stringify({
      event: "google_drive_connected",
      anonymousSessionId,
      googleAccountId: account.id,
    }),
  );
}

export function getOAuthReturnUrl(status: "connected" | "cancelled" | "failed"): string {
  const destination = validateOAuthReturnUri(env.googleOAuthReturnUri);
  destination.searchParams.set("status", status);
  return destination.toString();
}
