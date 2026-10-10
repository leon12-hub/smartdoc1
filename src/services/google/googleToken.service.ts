import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { google } from "googleapis";
import { db } from "../../prisma/db.js";
import { HttpError } from "../../utils/httpError.js";
import { createOAuthClient, tokenEncryptionKey } from "./googleConfig.js";

const algorithm = "aes-256-gcm";

export function encryptRefreshToken(token: string): string {
  if (!token || token.length > 16_384) {
    throw new TypeError("Google refresh token is invalid");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptRefreshToken(encrypted: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] =
    encrypted.split(".");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext ||
    extra.length > 0
  ) {
    throw new HttpError(500, "Stored Google Drive credentials are invalid");
  }
  try {
    const decipher = createDecipheriv(
      algorithm,
      tokenEncryptionKey(),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(500, "Stored Google Drive credentials could not be decrypted");
  }
}

export async function getConnectedDriveClient(anonymousSessionId: string) {
  const connection = await db.orm.public.GoogleDriveConnection
    .where({ anonymousSessionId })
    .first();
  if (!connection || connection.status === "DISCONNECTED") {
    throw new HttpError(409, "Connect Google Drive to continue", "DRIVE_NOT_CONNECTED");
  }
  if (connection.status === "REAUTH_REQUIRED" || !connection.encryptedRefreshToken) {
    throw new HttpError(
      409,
      "Google Drive connection expired. Please reconnect.",
      "DRIVE_REAUTH_REQUIRED",
    );
  }

  const oauth = createOAuthClient();
  const currentRefreshToken = decryptRefreshToken(connection.encryptedRefreshToken);
  oauth.setCredentials({
    refresh_token: currentRefreshToken,
  });
  let token: string | null | undefined;
  try {
    token = (await oauth.getAccessToken()).token;
  } catch (error) {
    if (isInvalidGrant(error)) {
      await db.orm.public.GoogleDriveConnection
        .where({ id: connection.id })
        .update({ status: "REAUTH_REQUIRED" });
      console.warn(
        JSON.stringify({
          event: "google_drive_token_refresh_failed",
          anonymousSessionId,
          reason: "reauthorization_required",
        }),
      );
      throw new HttpError(
        409,
        "Google Drive connection expired. Please reconnect.",
        "DRIVE_REAUTH_REQUIRED",
      );
    }
    console.warn(
      JSON.stringify({
        event: "google_drive_token_refresh_failed",
        anonymousSessionId,
        reason: "google_auth_unavailable",
      }),
    );
    throw new HttpError(502, "Unable to connect to Google Drive. Please try again.");
  }
  if (!token) {
    throw new HttpError(502, "Unable to connect to Google Drive. Please try again.");
  }
  const credentials = oauth.credentials;
  const update: {
    accessTokenExpiresAt?: Date | null;
    encryptedRefreshToken?: string;
  } = {};
  if (credentials.expiry_date) {
    update.accessTokenExpiresAt = new Date(credentials.expiry_date);
  }
  if (
    credentials.refresh_token &&
    credentials.refresh_token !== currentRefreshToken
  ) {
    update.encryptedRefreshToken = encryptRefreshToken(credentials.refresh_token);
  }
  if (Object.keys(update).length > 0) {
    await db.orm.public.GoogleDriveConnection
      .where({ id: connection.id })
      .update(update);
  }
  return { drive: google.drive({ version: "v3", auth: oauth }) };
}

export async function getConnectedAdminDriveClient(adminId: string) {
  const connection = await db.orm.public.AdminGoogleDriveConnection
    .where({ adminId })
    .first();
  if (!connection || connection.status === "DISCONNECTED") {
    throw new HttpError(409, "Connect the administrator's Google Drive to continue", "ADMIN_DRIVE_NOT_CONNECTED");
  }
  if (connection.status === "REAUTH_REQUIRED" || !connection.encryptedRefreshToken) {
    throw new HttpError(
      409,
      "The administrator's Google Drive connection expired. Please reconnect.",
      "ADMIN_DRIVE_REAUTH_REQUIRED",
    );
  }

  const currentRefreshToken = decryptRefreshToken(connection.encryptedRefreshToken);
  const oauth = createOAuthClient();
  oauth.setCredentials({ refresh_token: currentRefreshToken });
  let token: string | null | undefined;
  try {
    token = (await oauth.getAccessToken()).token;
  } catch (error) {
    if (isInvalidGrant(error)) {
      await db.orm.public.AdminGoogleDriveConnection
        .where({ id: connection.id })
        .update({ status: "REAUTH_REQUIRED" });
      throw new HttpError(
        409,
        "The administrator's Google Drive connection expired. Please reconnect.",
        "ADMIN_DRIVE_REAUTH_REQUIRED",
      );
    }
    throw new HttpError(502, "Unable to connect to the administrator's Google Drive.");
  }
  if (!token) {
    throw new HttpError(502, "Unable to connect to the administrator's Google Drive.");
  }

  const credentials = oauth.credentials;
  const update: {
    accessTokenExpiresAt?: Date | null;
    encryptedRefreshToken?: string;
  } = {};
  if (credentials.expiry_date) {
    update.accessTokenExpiresAt = new Date(credentials.expiry_date);
  }
  if (
    credentials.refresh_token &&
    credentials.refresh_token !== currentRefreshToken
  ) {
    update.encryptedRefreshToken = encryptRefreshToken(credentials.refresh_token);
  }
  if (Object.keys(update).length > 0) {
    await db.orm.public.AdminGoogleDriveConnection
      .where({ id: connection.id })
      .update(update);
  }
  return {
    connection,
    drive: google.drive({ version: "v3", auth: oauth }),
  };
}

export function isInvalidGrant(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const response = record["response"];
  const responseData =
    response !== null && typeof response === "object"
      ? (response as Record<string, unknown>)["data"]
      : undefined;
  const responseError =
    responseData !== null && typeof responseData === "object"
      ? (responseData as Record<string, unknown>)["error"]
      : undefined;
  return (
    record["code"] === "invalid_grant" ||
    responseError === "invalid_grant" ||
    record["message"] === "invalid_grant"
  );
}
