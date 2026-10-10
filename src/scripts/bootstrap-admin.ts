import "dotenv/config";
import { db } from "../prisma/db.js";
import { bootstrapAdmin } from "../services/adminAuth.service.js";

try {
  const result = await bootstrapAdmin({
    resetExistingPassword: process.argv.includes("--reset-password"),
  });
  console.log(
    result === "created"
      ? "Administrator created."
      : result === "password-reset"
        ? "Administrator password updated; existing sessions were revoked."
        : "Administrator already exists.",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Administrator bootstrap failed";
  const databaseUrl = process.env.DATABASE_URL;
  console.error(databaseUrl ? message.replaceAll(databaseUrl, "[DATABASE_URL]") : message);
  process.exitCode = 1;
} finally {
  await db.close();
}
