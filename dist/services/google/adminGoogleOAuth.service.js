import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import { Temporal } from "temporal-polyfill";
import { env } from "../../config/env.js";
import { db } from "../../prisma/db.js";
import { HttpError } from "../../utils/httpError.js";
import { createAdminToken } from "../../utils/jwt.js";
import { writeAdminLog } from "../adminLog.service.js";
import { createOAuthClient, googleDriveScope, googleProfileScopes, requireGoogleConfiguration, validateOAuthReturnUri, } from "./googleConfig.js";
import { decryptRefreshToken, encryptRefreshToken, isInvalidGrant, } from "./googleToken.service.js";
const oauthStateLifetimeSeconds = 600;
export async function beginAdminGoogleLogin(channel, requestedReturnUri) {
    requireGoogleConfiguration();
    if (!env.adminEmail)
        throw new HttpError(503, "ADMIN_EMAIL is not configured");
    const returnUri = channel === "web"
        ? validateAdminLoginReturnUri(requestedReturnUri ?? env.adminGoogleLoginReturnUri)
        : null;
    const now = Temporal.Now.instant();
    await db.orm.public.AdminGoogleLoginState
        .where((state) => state.expiresAt.lt(now))
        .delete();
    const nonce = randomBytes(32).toString("base64url");
    const state = returnUri ? signAdminLoginReturnUri(nonce, returnUri) : nonce;
    const id = createHash("sha256").update(state).digest("hex");
    await db.orm.public.AdminGoogleLoginState.create({
        id,
        channel: channel === "web" ? "WEB" : "MOBILE",
        expiresAt: now.add({ seconds: oauthStateLifetimeSeconds }),
        consumedBy: null,
        adminId: null,
        completionCodeHash: null,
        completionExpiresAt: null,
        completionConsumedAt: null,
        completionConsumedBy: null,
    });
    return createOAuthClient().generateAuthUrl({
        access_type: "offline",
        include_granted_scopes: true,
        prompt: "consent",
        state,
        scope: [googleDriveScope, ...googleProfileScopes],
    });
}
export async function consumeAdminGoogleLoginState(state) {
    const returnUri = readAdminLoginReturnUri(state);
    if (!returnUri && !/^[A-Za-z0-9_-]{43}$/.test(state)) {
        throw new HttpError(400, "Google authorization state is invalid");
    }
    const id = createHash("sha256").update(state).digest("hex");
    const record = await db.orm.public.AdminGoogleLoginState.where({ id }).first();
    if (!record)
        return null;
    if (record.consumedBy !== null) {
        throw new HttpError(400, "Google authorization state has already been used");
    }
    if (Temporal.Instant.compare(record.expiresAt, Temporal.Now.instant()) <= 0) {
        throw new HttpError(400, "Google authorization state has expired");
    }
    const claimId = randomUUID();
    await db.orm.public.AdminGoogleLoginState
        .where({ id, consumedBy: null })
        .update({ consumedBy: claimId });
    const claimed = await db.orm.public.AdminGoogleLoginState
        .where({ id, consumedBy: claimId })
        .first();
    if (!claimed)
        throw new HttpError(400, "Google authorization state has already been used");
    return { id, channel: claimed.channel, returnUri };
}
export async function finishAdminGoogleLogin(stateId, channel, authorizationCode) {
    if (!env.adminEmail)
        throw new HttpError(503, "ADMIN_EMAIL is not configured");
    const admin = await db.orm.public.User
        .select("id", "email", "name", "role", "isActive")
        .where({ email: env.adminEmail })
        .first();
    if (!admin || admin.role !== "ADMIN" || !admin.isActive) {
        throw new HttpError(403, "The configured Google account is not an active SmartDoc administrator");
    }
    const { tokens, account } = await exchangeGoogleGrant(authorizationCode);
    if (!account.id ||
        !account.email ||
        account.verified_email !== true ||
        account.email.trim().toLowerCase() !== admin.email.trim().toLowerCase()) {
        throw new HttpError(403, "Sign in with the configured SmartDoc administrator Google account");
    }
    await saveAdminGoogleDriveGrant(admin.id, tokens, account);
    const adminInfo = { id: admin.id, email: admin.email, name: admin.name };
    if (channel === "WEB") {
        const session = createAdminToken(adminInfo);
        await db.orm.public.AdminSession.create({
            id: session.sessionId,
            adminId: admin.id,
            revokedAt: null,
        });
        await writeAdminLog(admin.id, "admin.google_login", "admin", admin.id);
        return { adminId: admin.id, admin: adminInfo, token: session.token };
    }
    const completionCode = randomBytes(32).toString("base64url");
    const now = Temporal.Now.instant();
    await db.orm.public.AdminGoogleLoginState.where({ id: stateId }).update({
        adminId: admin.id,
        completionCodeHash: createHash("sha256").update(completionCode).digest("hex"),
        completionExpiresAt: now.add({ seconds: 120 }),
        completionConsumedAt: null,
        completionConsumedBy: null,
    });
    return { adminId: admin.id, admin: adminInfo, completionCode };
}
export async function consumeAdminGoogleLoginCompletion(completionCode) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(completionCode)) {
        throw new HttpError(400, "Google sign-in completion code is invalid or expired");
    }
    const completionCodeHash = createHash("sha256").update(completionCode).digest("hex");
    const record = await db.orm.public.AdminGoogleLoginState
        .where({ completionCodeHash })
        .first();
    if (!record ||
        !record.adminId ||
        record.completionConsumedAt !== null ||
        !record.completionExpiresAt ||
        Temporal.Instant.compare(record.completionExpiresAt, Temporal.Now.instant()) <= 0) {
        throw new HttpError(400, "Google sign-in completion code is invalid or expired");
    }
    const claimId = randomUUID();
    await db.orm.public.AdminGoogleLoginState
        .where({ id: record.id, completionCodeHash, completionConsumedAt: null })
        .update({
        completionCodeHash: null,
        completionConsumedAt: Temporal.Now.instant(),
        completionConsumedBy: claimId,
    });
    const claimed = await db.orm.public.AdminGoogleLoginState
        .where({ id: record.id, completionConsumedBy: claimId })
        .first();
    if (!claimed?.adminId) {
        throw new HttpError(400, "Google sign-in completion code has already been used");
    }
    const admin = await db.orm.public.User
        .select("id", "email", "name", "role", "isActive")
        .where({ id: claimed.adminId })
        .first();
    if (!admin || admin.role !== "ADMIN" || !admin.isActive) {
        throw new HttpError(403, "Administrator access is forbidden");
    }
    const session = createAdminToken({ id: admin.id, email: admin.email, name: admin.name });
    await db.orm.public.AdminSession.create({
        id: session.sessionId,
        adminId: admin.id,
        revokedAt: null,
    });
    await writeAdminLog(admin.id, "admin.google_login", "admin", admin.id);
    return {
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        token: session.token,
    };
}
export async function beginAdminGoogleDriveConnection(adminId, adminSessionId, prompt = "consent") {
    requireGoogleConfiguration();
    const now = Temporal.Now.instant();
    await db.orm.public.AdminGoogleOAuthState
        .where((state) => state.expiresAt.lt(now))
        .delete();
    const state = randomBytes(32).toString("base64url");
    const id = createHash("sha256").update(state).digest("hex");
    await db.orm.public.AdminGoogleOAuthState.create({
        id,
        adminSessionId,
        expiresAt: now.add({ seconds: oauthStateLifetimeSeconds }),
        consumedBy: null,
    });
    const authorizationUrl = createOAuthClient().generateAuthUrl({
        access_type: "offline",
        include_granted_scopes: true,
        prompt,
        state,
        scope: [googleDriveScope, ...googleProfileScopes],
    });
    console.info(JSON.stringify({ event: "admin_google_drive_oauth_started", adminId }));
    return authorizationUrl;
}
export async function consumeAdminGoogleOAuthState(state) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
        return null;
    }
    const id = createHash("sha256").update(state).digest("hex");
    const record = await db.orm.public.AdminGoogleOAuthState.where({ id }).first();
    if (!record)
        return null;
    if (record.consumedBy !== null) {
        throw new HttpError(400, "Google Drive authorization state has already been used");
    }
    if (Temporal.Instant.compare(record.expiresAt, Temporal.Now.instant()) <= 0) {
        throw new HttpError(400, "Google Drive authorization state has expired");
    }
    const claimId = randomUUID();
    await db.orm.public.AdminGoogleOAuthState
        .where({ id, consumedBy: null })
        .update({ consumedBy: claimId });
    const claimed = await db.orm.public.AdminGoogleOAuthState
        .where({ id, consumedBy: claimId })
        .first();
    if (!claimed) {
        throw new HttpError(400, "Google Drive authorization state has already been used");
    }
    const session = await db.orm.public.AdminSession.where({ id: claimed.adminSessionId }).first();
    if (!session || session.revokedAt !== null) {
        throw new HttpError(401, "The administrator session has expired");
    }
    const admin = await db.orm.public.User
        .select("id", "role", "isActive")
        .where({ id: session.adminId })
        .first();
    if (!admin || admin.role !== "ADMIN" || !admin.isActive) {
        throw new HttpError(403, "Administrator access is forbidden");
    }
    return { adminId: admin.id, adminSessionId: session.id };
}
export async function finishAdminGoogleDriveConnection(adminId, authorizationCode) {
    requireGoogleConfiguration();
    if (!authorizationCode || authorizationCode.length > 4096) {
        throw new HttpError(400, "Google authorization code is invalid");
    }
    const admin = await db.orm.public.User
        .select("id", "email", "role", "isActive")
        .where({ id: adminId })
        .first();
    if (!admin || admin.role !== "ADMIN" || !admin.isActive) {
        throw new HttpError(403, "Administrator access is forbidden");
    }
    const { tokens, account } = await exchangeGoogleGrant(authorizationCode);
    if (!account.id || !account.email || account.verified_email === false || account.email.trim() === "") {
        throw new HttpError(502, "Google did not provide a verified account");
    }
    if (account.email.trim().toLowerCase() !== admin.email.trim().toLowerCase()) {
        throw new HttpError(403, `Connect Google Drive with the administrator account ${admin.email}`);
    }
    await saveAdminGoogleDriveGrant(adminId, tokens, account);
    console.info(JSON.stringify({ event: "admin_google_drive_connected", adminId, googleAccountId: account.id }));
}
export async function getAdminGoogleDriveStatus(adminId) {
    const connection = await db.orm.public.AdminGoogleDriveConnection.where({ adminId }).first();
    if (!connection || connection.status === "DISCONNECTED") {
        return { connected: false, provider: "google-drive" };
    }
    return {
        connected: connection.status === "CONNECTED",
        provider: "google-drive",
        email: connection.googleEmail,
        status: connection.status,
        connectedAt: connection.connectedAt,
    };
}
export async function disconnectAdminGoogleDrive(adminId) {
    const connection = await db.orm.public.AdminGoogleDriveConnection.where({ adminId }).first();
    if (!connection || connection.status === "DISCONNECTED")
        return;
    try {
        const refreshToken = connection.encryptedRefreshToken
            ? decryptRefreshToken(connection.encryptedRefreshToken)
            : "";
        if (refreshToken)
            await createOAuthClient().revokeToken(refreshToken);
    }
    catch {
        console.warn(JSON.stringify({ event: "admin_google_drive_token_revoke_failed", adminId }));
    }
    await db.orm.public.AdminGoogleDriveConnection.where({ id: connection.id }).update({
        encryptedRefreshToken: "",
        status: "DISCONNECTED",
        disconnectedAt: new Date(),
    });
    console.info(JSON.stringify({ event: "admin_google_drive_disconnected", adminId }));
}
export function getAdminOAuthReturnUrl(status) {
    let destination;
    try {
        destination = new URL(env.adminGoogleOAuthReturnUri);
    }
    catch {
        throw new HttpError(503, "Admin Google Drive OAuth return URL is invalid");
    }
    const allowed = destination.protocol === "https:" || (destination.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(destination.hostname));
    if (!allowed || destination.username || destination.password || destination.hash) {
        throw new HttpError(503, "Admin Google Drive OAuth return URL is not allowed");
    }
    destination.searchParams.set("drive", status);
    return validateOAuthReturnUri(destination.toString()).toString();
}
export function getAdminGoogleLoginReturnUrl(status, returnUri) {
    const destination = new URL(validateAdminLoginReturnUri(returnUri ?? env.adminGoogleLoginReturnUri));
    destination.searchParams.set("google", status);
    return destination.toString();
}
function validateAdminLoginReturnUri(value) {
    if (typeof value !== "string") {
        throw new HttpError(400, "Admin Google login return URL must be a string");
    }
    if (value.length > 2048)
        throw new HttpError(400, "Admin Google login return URL is too long");
    let destination;
    try {
        destination = new URL(value);
    }
    catch {
        throw new HttpError(400, "Admin Google login return URL is invalid");
    }
    const allowedProtocol = destination.protocol === "https:" || (destination.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(destination.hostname));
    const allowedUri = env.adminGoogleLoginReturnUris.some((uri) => {
        try {
            return new URL(uri).toString() === destination.toString();
        }
        catch {
            return false;
        }
    });
    if (!allowedProtocol || !allowedUri || destination.username || destination.password || destination.hash) {
        throw new HttpError(400, "Admin Google login return URL is not allowed");
    }
    return destination.toString();
}
function signAdminLoginReturnUri(nonce, returnUri) {
    const encodedUri = Buffer.from(returnUri).toString("base64url");
    const unsigned = `${nonce}.${encodedUri}`;
    const signature = createHmac("sha256", env.jwtSecret).update(unsigned).digest("base64url");
    return `${unsigned}.${signature}`;
}
export function readAdminLoginReturnUri(state) {
    if (state.length > 4096)
        throw new HttpError(400, "Google authorization state is invalid");
    const parts = state.split(".");
    if (parts.length === 1)
        return null;
    if (parts.length !== 3 ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[0]) ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
        throw new HttpError(400, "Google authorization state is invalid");
    }
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", env.jwtSecret).update(unsigned).digest();
    const supplied = Buffer.from(parts[2], "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new HttpError(400, "Google authorization state is invalid");
    }
    const returnUri = Buffer.from(parts[1], "base64url").toString("utf8");
    if (Buffer.from(returnUri).toString("base64url") !== parts[1]) {
        throw new HttpError(400, "Google authorization state is invalid");
    }
    return validateAdminLoginReturnUri(returnUri);
}
export function getAdminMobileLoginReturnUrl(result) {
    const destination = new URL("smartdoc://admin/callback");
    if ("code" in result)
        destination.searchParams.set("code", result.code);
    else
        destination.searchParams.set("status", result.status);
    return destination.toString();
}
async function exchangeGoogleGrant(authorizationCode) {
    if (!authorizationCode || authorizationCode.length > 4096) {
        throw new HttpError(400, "Google authorization code is invalid");
    }
    const oauth = createOAuthClient();
    let tokens;
    try {
        tokens = (await oauth.getToken(authorizationCode)).tokens;
    }
    catch (error) {
        console.warn(JSON.stringify({
            event: "admin_google_oauth_failed",
            reason: isInvalidGrant(error) ? "authorization_code_rejected" : "token_exchange_failed",
        }));
        throw new HttpError(400, "Google authorization could not be completed. Please try again.");
    }
    oauth.setCredentials(tokens);
    try {
        const account = (await google.oauth2({ version: "v2", auth: oauth }).userinfo.get()).data;
        return { tokens, account };
    }
    catch {
        throw new HttpError(502, "Could not verify the authorized Google account");
    }
}
async function saveAdminGoogleDriveGrant(adminId, tokens, account) {
    if (!account.id || !account.email) {
        throw new HttpError(502, "Google did not provide a verified account");
    }
    const existing = await db.orm.public.AdminGoogleDriveConnection.where({ adminId }).first();
    const scopes = tokens.scope ?? existing?.scopes ?? "";
    if (!scopes.split(/\s+/).includes(googleDriveScope)) {
        throw new HttpError(403, "Google Drive did not grant the required file access permission.");
    }
    let encryptedRefreshToken = existing?.encryptedRefreshToken ?? "";
    if (tokens.refresh_token) {
        encryptedRefreshToken = encryptRefreshToken(tokens.refresh_token);
    }
    else if (!existing ||
        existing.status === "DISCONNECTED" ||
        existing.googleAccountId !== account.id ||
        !encryptedRefreshToken) {
        throw new HttpError(400, "Google did not provide a refresh token. Revoke SmartDoc access in Google Account settings and connect again.");
    }
    const values = {
        googleAccountId: account.id,
        googleEmail: account.email,
        encryptedRefreshToken,
        scopes,
        accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        status: "CONNECTED",
        connectedAt: existing?.status === "CONNECTED" && existing.googleAccountId === account.id
            ? existing.connectedAt
            : Temporal.Now.instant(),
        disconnectedAt: null,
    };
    if (existing) {
        await db.orm.public.AdminGoogleDriveConnection.where({ id: existing.id }).update(values);
    }
    else {
        await db.orm.public.AdminGoogleDriveConnection.create({ adminId, ...values });
    }
}
