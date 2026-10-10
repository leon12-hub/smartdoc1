import { db } from "../prisma/db.js";

export async function writeAdminLog(
  adminId: string | null,
  action: string,
  resourceType: string | null = null,
  resourceId: string | null = null,
): Promise<void> {
  await db.orm.public.AdminLog.create({
    adminId,
    action,
    resourceType,
    resourceId,
  });
}
