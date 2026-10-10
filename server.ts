import express from "express";
import cors from "cors";
import "dotenv/config";
import { adminAuthRouter } from "./routes/adminAuth.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { documentRouter } from "./routes/document.routes.js";
import { folderRouter } from "./routes/folder.routes.js";
import { anonymousSessionRouter } from "./routes/anonymousSession.routes.js";
import { googleDriveRouter } from "./routes/googleDrive.routes.js";
import { userRouter } from "./routes/user.routes.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { requireAdmin } from "./middleware/adminAuth.middleware.js";
import { requireAnonymousSession } from "./middleware/anonymousSession.middleware.js";
import { notificationRouter } from "./routes/notification.routes.js";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000,http://localhost:5173,http://localhost:8080")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  }),
);
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "SmartDoc API is running",
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "SmartDoc Backend",
    status: "healthy",
  });
});

app.use("/api/session", anonymousSessionRouter);
app.use("/api/users", userRouter);
app.use("/api/google/drive", googleDriveRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/admin", requireAdmin, adminRouter);
app.use("/api/documents", requireAnonymousSession, documentRouter);
app.use("/api/folders", requireAnonymousSession, folderRouter);
app.use(errorMiddleware);

const port = Number(process.env.PORT ?? 5000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

app.listen(port, () =>
  console.log(`SmartDoc API running on http://localhost:${port}`),
);
