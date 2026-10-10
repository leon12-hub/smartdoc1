import { google } from "googleapis";
import { env } from "../../config/env.js";
import { HttpError } from "../../utils/httpError.js";

export const googleDriveScope = "https://www.googleapis.com/auth/drive.file";
export const googleProfileScopes = ["openid", "email"];

export function requireGoogleConfiguration(): void {
  if (
    !env.googleClientId ||
    !env.googleClientSecret ||
    !env.googleRedirectUri ||
    !env.googleTokenEncryptionKey
  ) {
    throw new HttpError(503, "Google Drive integration is not configured");
  }
  tokenEncryptionKey();
  validateOAuthReturnUri(env.googleOAuthReturnUri);
}

export function createOAuthClient() {
  requireGoogleConfiguration();
  return new google.auth.OAuth2(
    env.googleClientId,
    env.googleClientSecret,
    env.googleRedirectUri,
  );
}

export function tokenEncryptionKey(): Buffer {
  const value = env.googleTokenEncryptionKey;
  const key =
    /^[0-9a-f]{64}$/i.test(value)
      ? Buffer.from(value, "hex")
      : /^[A-Za-z0-9_-]{43,44}$/.test(value)
        ? Buffer.from(value, "base64url")
        : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new HttpError(
      503,
      "Google Drive token encryption is not configured with a valid 32-byte key",
    );
  }
  return key;
}

export function validateOAuthReturnUri(value: string): URL {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new HttpError(503, "Google Drive OAuth return URL is invalid");
  }
  const isSmartDocApp = uri.protocol === "smartdoc:" && uri.hostname === "drive";
  const isDevelopmentWeb =
    uri.protocol === "http:" &&
    (uri.hostname === "localhost" || uri.hostname === "127.0.0.1");
  const isSecureWeb = uri.protocol === "https:";
  if (
    (!isSmartDocApp && !isDevelopmentWeb && !isSecureWeb) ||
    uri.username ||
    uri.password ||
    uri.hash
  ) {
    throw new HttpError(503, "Google Drive OAuth return URL is not allowed");
  }
  return uri;
}
