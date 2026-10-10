import { env } from "../config/env.js";
export const anonymousCookieName = "smartdoc_guest";
export const adminCookieName = "smartdoc_admin";
export function readCookie(req, name) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
        return undefined;
    }
    for (const cookie of cookieHeader.split(";")) {
        const separator = cookie.indexOf("=");
        if (separator < 0 || cookie.slice(0, separator).trim() !== name) {
            continue;
        }
        try {
            return decodeURIComponent(cookie.slice(separator + 1).trim());
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
export function setAuthCookie(res, name, token, maxAgeSeconds) {
    res.cookie(name, token, {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: maxAgeSeconds * 1000,
    });
}
export function clearAuthCookie(res, name) {
    res.clearCookie(name, {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: "lax",
        path: "/",
    });
}
