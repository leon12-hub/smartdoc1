import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

process.env.JWT_SECRET = "test-only-smartdoc-secret-with-at-least-32-characters";
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64url");
process.env.ADMIN_GOOGLE_LOGIN_RETURN_URIS =
  "http://localhost:3000/admin/auth,http://localhost:5173/";

const { readAdminLoginReturnUri } =
  await import("../dist/services/google/adminGoogleOAuth.service.js");

function makeSignedState(returnUri) {
  const nonce = Buffer.alloc(32, 5).toString("base64url");
  const encodedUri = Buffer.from(returnUri).toString("base64url");
  const unsigned = `${nonce}.${encodedUri}`;
  const signature = createHmac("sha256", process.env.JWT_SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

test("web admin login state returns only a signed, allowlisted callback URI", () => {
  assert.equal(readAdminLoginReturnUri(randomBytes(32).toString("base64url")), null);
  assert.equal(readAdminLoginReturnUri(makeSignedState("http://localhost:5173/")), "http://localhost:5173/");
  assert.equal(
    readAdminLoginReturnUri(makeSignedState("http://localhost:3000/admin/auth")),
    "http://localhost:3000/admin/auth",
  );
});

test("web admin login state rejects tampering and unlisted callback URLs", () => {
  const state = makeSignedState("http://localhost:5173/");
  const tampered = state.split(".");
  tampered[1] = `${tampered[1][0] === "A" ? "B" : "A"}${tampered[1].slice(1)}`;
  assert.throws(() => readAdminLoginReturnUri(tampered.join(".")));
  assert.throws(() => readAdminLoginReturnUri(makeSignedState("https://attacker.example/callback")));
});
