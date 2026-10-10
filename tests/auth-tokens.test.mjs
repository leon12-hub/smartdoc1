import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-only-smartdoc-secret-with-at-least-32-characters";

const {
  createAdminToken,
  createAnonymousToken,
  anonymousTokenMatches,
  hashAnonymousToken,
  verifyAccessToken,
  verifyAdminToken,
  verifyAnonymousToken,
} =
  await import("../dist/utils/jwt.js");
const { hasMatchingSignature, safeOriginalName } =
  await import("../dist/utils/uploadStorage.js");

test("anonymous session tokens are valid only for guest ownership", () => {
  const session = createAnonymousToken();

  assert.equal(verifyAnonymousToken(session.token), session.sessionId);
  assert.equal(verifyAdminToken(session.token), null);
});

test("admin tokens are valid only for administrator authentication", () => {
  const admin = { id: "admin-id", name: "Admin", email: "admin@example.com" };
  const { token } = createAdminToken(admin);

  assert.deepEqual(verifyAdminToken(token), admin);
  assert.equal(verifyAnonymousToken(token), null);
});

test("a valid non-admin user token is recognized as authenticated but not as an admin", () => {
  const token = jwt.sign({ role: "USER", typ: "user" }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    issuer: "smartdoc-api",
    subject: "user-id",
  });

  assert.deepEqual(verifyAccessToken(token), { id: "user-id", role: "USER" });
  assert.equal(verifyAdminToken(token), null);
});

test("tampered tokens are rejected", () => {
  const { token } = createAnonymousToken();
  const tamperedToken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  assert.equal(verifyAnonymousToken(tamperedToken), null);
  assert.equal(verifyAdminToken(tamperedToken), null);
});

test("anonymous session hashes match only the issued token", () => {
  const { token } = createAnonymousToken();
  const tokenHash = hashAnonymousToken(token);

  assert.equal(anonymousTokenMatches(token, tokenHash), true);
  assert.equal(anonymousTokenMatches(`${token}tampered`, tokenHash), false);
  assert.equal(anonymousTokenMatches(token, "invalid-hash"), false);
});

test("upload validation checks file signatures and strips unsafe path components", () => {
  assert.equal(hasMatchingSignature(Buffer.from("%PDF-1.7"), "application/pdf"), true);
  assert.equal(hasMatchingSignature(Buffer.from("not a pdf"), "application/pdf"), false);
  assert.deepEqual(safeOriginalName("..\\private\\scan.pdf"), {
    name: "scan.pdf",
    extension: "pdf",
  });
});
