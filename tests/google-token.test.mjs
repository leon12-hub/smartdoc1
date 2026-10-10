import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = "test-only-smartdoc-secret-with-at-least-32-characters";
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64url");

const { decryptRefreshToken, encryptRefreshToken, isInvalidGrant } =
  await import("../dist/services/google/googleToken.service.js");
const { validateOAuthReturnUri } =
  await import("../dist/services/google/googleConfig.js");
const { consumeGoogleOAuthState } =
  await import("../dist/services/google/googleOAuth.service.js");

test("refresh tokens are encrypted with authenticated, randomized AES-GCM", () => {
  const refreshToken = "test-refresh-token-never-for-production";
  const first = encryptRefreshToken(refreshToken);
  const second = encryptRefreshToken(refreshToken);

  assert.notEqual(first, refreshToken);
  assert.notEqual(first, second);
  assert.equal(decryptRefreshToken(first), refreshToken);
});

test("encrypted refresh tokens reject tampering and malformed ciphertext", () => {
  const encrypted = encryptRefreshToken("refresh-token");
  const parts = encrypted.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => decryptRefreshToken(parts.join(".")));
  assert.throws(() => decryptRefreshToken("plaintext-token"));
});

test("Google error classification recognizes revoked refresh credentials", () => {
  assert.equal(isInvalidGrant({ code: "invalid_grant" }), true);
  assert.equal(
    isInvalidGrant({ response: { data: { error: "invalid_grant" } } }),
    true,
  );
  assert.equal(isInvalidGrant({ code: "ECONNRESET" }), false);
});

test("OAuth redirects allow only secure web URLs, local development, and the app link", () => {
  assert.equal(
    validateOAuthReturnUri("smartdoc://drive/callback").protocol,
    "smartdoc:",
  );
  assert.equal(
    validateOAuthReturnUri("http://localhost:3000/google-drive/callback").hostname,
    "localhost",
  );
  assert.equal(
    validateOAuthReturnUri("https://smartdoc.example/google-drive/callback").protocol,
    "https:",
  );
  assert.throws(() => validateOAuthReturnUri("javascript:alert(1)"));
  assert.throws(() => validateOAuthReturnUri("https://user:password@example.com/cb"));
});

test("OAuth callback rejects malformed state before database or external access", async () => {
  await assert.rejects(() => consumeGoogleOAuthState("missing"));
});
