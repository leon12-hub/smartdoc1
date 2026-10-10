import "dotenv/config";

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be configured with at least 32 characters");
}

export const env = {
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  adminEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "",
  port: process.env.PORT ?? "5000",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
  googleTokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? "",
  googleOAuthReturnUri: process.env.GOOGLE_OAUTH_RETURN_URI ?? "smartdoc://drive/callback",
  adminGoogleOAuthReturnUri:
    process.env.ADMIN_GOOGLE_OAUTH_RETURN_URI ??
    "http://localhost:3000/admin/settings/authentication",
  adminGoogleLoginReturnUri:
    process.env.ADMIN_GOOGLE_LOGIN_RETURN_URI ?? "http://localhost:3000/admin/auth",
  adminGoogleLoginReturnUris: (
    process.env.ADMIN_GOOGLE_LOGIN_RETURN_URIS ??
    `${process.env.ADMIN_GOOGLE_LOGIN_RETURN_URI ?? "http://localhost:3000/admin/auth"},http://localhost:5173/`
  ).split(",").map((uri) => uri.trim()).filter(Boolean),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  isProduction: process.env.NODE_ENV === "production",
  maxFileSizeMb: parsePositiveInteger(process.env.MAX_FILE_SIZE_MB, 25, 100),
  allowedDocumentTypes: parseAllowedDocumentTypes(
    process.env.ALLOWED_DOCUMENT_TYPES ?? "pdf,jpg,jpeg,png,webp",
  ),
};

function parsePositiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`MAX_FILE_SIZE_MB must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function parseAllowedDocumentTypes(value: string): ReadonlySet<string> {
  const supported = new Set(["pdf", "jpg", "jpeg", "png", "webp"]);
  const types = value.split(",").map((type) => type.trim().toLowerCase()).filter(Boolean);
  if (types.length === 0 || types.some((type) => !supported.has(type))) {
    throw new Error("ALLOWED_DOCUMENT_TYPES may contain only pdf,jpg,jpeg,png,webp");
  }
  return new Set(types);
}

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error("JWT_EXPIRES_IN must use seconds, minutes, hours, or days (for example: 7d)");
  }

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("JWT_EXPIRES_IN must resolve to a positive number of seconds");
  }

  return seconds;
}
