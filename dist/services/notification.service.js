import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../utils/httpError.js";
const notificationFields = [
    "id",
    "kind",
    "title",
    "message",
    "createdAt",
    "readAt",
];
export async function createGuestNotification(anonymousSessionId, kind, title, message) {
    await db.orm.public.Notification.create({
        anonymousSessionId,
        kind,
        title,
        message,
        readAt: null,
    });
}
export async function listGuestNotifications(anonymousSessionId) {
    const [notifications, unread] = await Promise.all([
        db.orm.public.Notification
            .select(...notificationFields)
            .where({ anonymousSessionId })
            .orderBy((notification) => notification.createdAt.desc())
            .limit(50)
            .all(),
        db.orm.public.Notification
            .where({ anonymousSessionId, readAt: null })
            .aggregate((aggregate) => ({ total: aggregate.count() })),
    ]);
    return { notifications, unreadCount: unread.total };
}
export async function markGuestNotificationRead(anonymousSessionId, notificationId) {
    const notification = await db.orm.public.Notification
        .where({ id: notificationId, anonymousSessionId })
        .first();
    if (!notification) {
        throw new HttpError(404, "Notification not found");
    }
    if (notification.readAt === null) {
        await db.orm.public.Notification
            .where({ id: notificationId, anonymousSessionId, readAt: null })
            .update({ readAt: Temporal.Now.instant() });
    }
}
