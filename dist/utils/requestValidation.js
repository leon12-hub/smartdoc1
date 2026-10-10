import { HttpError } from "./httpError.js";
export function requireSessionId(value) {
    if (typeof value !== "string") {
        throw new HttpError(401, "Anonymous session is required");
    }
    return value;
}
export function requireObjectBody(value) {
    if (!isRecord(value)) {
        throw new HttpError(400, "Request body must be a JSON object");
    }
    return value;
}
export function requireAdminSessionId(value) {
    if (typeof value !== "string") {
        throw new HttpError(401, "Administrator session is required");
    }
    return value;
}
export function requireSessionResponseContext(res) {
    return requireSessionId(res.locals.anonymousSessionId);
}
export function parseId(value) {
    if (typeof value !== "string" || !/^[a-z0-9]{24}$/i.test(value)) {
        throw new HttpError(400, "Invalid resource ID");
    }
    return value;
}
export function parsePage(value, defaultValue, maxValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
        throw new HttpError(400, "Pagination values must be positive integers");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (maxValue !== undefined && parsed > maxValue)) {
        throw new HttpError(400, `Pagination value must not exceed ${maxValue}`);
    }
    return parsed;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
