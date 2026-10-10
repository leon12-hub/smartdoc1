import { db } from "../prisma/db.js";
export async function writeAdminLog(adminId, action, resourceType = null, resourceId = null) {
    await db.orm.public.AdminLog.create({
        adminId,
        action,
        resourceType,
        resourceId,
    });
}
