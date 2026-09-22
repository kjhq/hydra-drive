import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canPersistTokens,
  createOAuthChallenge,
  GOOGLE_SCOPES,
  validOAuthState,
} from "./oauth-policy.js";
test("PKCE challenge binds verifier and state is fresh per request", () => {
  const a = createOAuthChallenge(),
    b = createOAuthChallenge();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(
    a.challenge,
    createHash("sha256").update(a.verifier).digest("base64url")
  );
  assert(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert(validOAuthState(a.state, a.state));
  assert(!validOAuthState(a.state, null));
  assert(!validOAuthState(a.state, b.state));
  assert(!validOAuthState(a.state, "short"));
});
test("Linux basic_text cannot persist refresh tokens", () => {
  assert(!canPersistTokens("linux", true, "basic_text"));
  assert(!canPersistTokens("linux", true, "unknown"));
  assert(!canPersistTokens("win32", false, "native"));
  assert(canPersistTokens("linux", true, "gnome_libsecret"));
});
test("OAuth requests only app-created file access", () => {
  assert(GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/drive.file"));
  assert(!GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/drive"));
});
