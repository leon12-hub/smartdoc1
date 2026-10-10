import type { ErrorRequestHandler } from "express";
import multer from "multer";
import { HttpError } from "../utils/httpError.js";

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Uploaded file exceeds the configured size limit"
          : error.message,
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return;
  }

  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ success: false, message: "Request body must be valid JSON" });
    return;
  }

  console.error("Unhandled request error:", error);
  res.status(500).json({ success: false, message: "Internal server error" });
};
