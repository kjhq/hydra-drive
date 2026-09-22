import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
];
export function createOAuthChallenge() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}
export function validOAuthState(expected: string, actual: string | null) {
  if (!actual) return false;
  const a = Buffer.from(expected),
    b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function canPersistTokens(
  platform: string,
  encryptionAvailable: boolean,
  backend: string
) {
  return (
    encryptionAvailable &&
    (platform !== "linux" || !["basic_text", "unknown"].includes(backend))
  );
}
