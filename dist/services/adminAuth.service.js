import bcrypt from "bcryptjs";
import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { writeAdminLog } from "./adminLog.service.js";
export async function logoutAdmin(sessionId, adminId) {
    await db.orm.public.AdminSession
        .where({ id: sessionId })
        .update({ revokedAt: Temporal.Instant.fromEpochMilliseconds(Date.now()) });
    await writeAdminLog(adminId, "admin.logout", "admin-session", sessionId);
}
export async function bootstrapAdmin(options = {}) {
    const emailValue = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME?.trim() || "SmartDoc Admin";
    if (!emailValue || !password) {
        throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD before running admin:bootstrap");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
        throw new Error("ADMIN_EMAIL must be a valid email address");
    }
    if (Buffer.byteLength(password, "utf8") < 12 || Buffer.byteLength(password, "utf8") > 72) {
        throw new Error("ADMIN_PASSWORD must contain between 12 and 72 UTF-8 bytes");
    }
    if (name.length === 0) {
        throw new Error("ADMIN_NAME must not be empty");
    }
    const existing = await db.orm.public.User.where({ email: emailValue }).first();
    if (existing) {
        if (existing.role !== "ADMIN") {
            throw new Error("ADMIN_EMAIL is already assigned to a non-administrator account");
        }
        if (options.resetExistingPassword) {
            const passwordHash = await bcrypt.hash(password, 12);
            await db.orm.public.User
                .where({ id: existing.id })
                .update({ passwordHash });
            await db.orm.public.AdminSession
                .where({ adminId: existing.id, revokedAt: null })
                .update({ revokedAt: Temporal.Now.instant() });
            await writeAdminLog(existing.id, "admin.password.reset", "admin", existing.id);
            return "password-reset";
        }
        return "already-exists";
    }
    const existingAdmins = await db.orm.public.User.where({ role: "ADMIN" }).select("id").limit(1).all();
    if (existingAdmins.length > 0) {
        throw new Error("An administrator already exists; refusing to create another from environment credentials");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await db.orm.public.User.create({
        name,
        email: emailValue,
        passwordHash,
        role: "ADMIN",
        isActive: true,
    });
    return "created";
}
