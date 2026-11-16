import { describe, expect, it } from "vitest";
import {
  deriveFileLinkKey,
  isAppLinkableKey,
  isLinkableKey,
  linkPathForKey,
  s3KeyFromLinkPath,
  signedFileLink,
  signFileLinkToken,
  verifyFileLinkToken,
} from "./file-link";

const key = deriveFileLinkKey("duo-secret");
const other = deriveFileLinkKey("another-secret");
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const doc = "home/documents/7f0c2a9e-1b2c-4d5e-8f90-123456789abc.pdf";
const att = "home/attachments/task/t1/a1.jpg";

describe("file links", () => {
  it("derives a key distinct from the raw secret", () => {
    expect(key).toBe(deriveFileLinkKey("duo-secret"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(other);
    expect(() => deriveFileLinkKey("")).toThrow();
  });

  it("maps keys to paths and back", () => {
    expect(linkPathForKey(doc)).toBe("/api/d/7f0c2a9e-1b2c-4d5e-8f90-123456789abc.pdf");
    expect(linkPathForKey(att)).toBe("/api/d/attachments/task/t1/a1.jpg");
    expect(linkPathForKey("home/attachments/x/y/my file.pdf")).toBe("/api/d/attachments/x/y/my%20file.pdf");
    expect(s3KeyFromLinkPath(["7f0c2a9e-1b2c-4d5e-8f90-123456789abc.pdf"])).toBe(doc);
    expect(s3KeyFromLinkPath(["attachments", "task", "t1", "a1.jpg"])).toBe(att);
    expect(s3KeyFromLinkPath(["documents", "sub", "x.pdf"])).toBe("home/documents/sub/x.pdf");
    expect(linkPathForKey("home/documents/sub/x.pdf")).toBe("/api/d/documents/sub/x.pdf");
  });

  it("only links keys under home/ without dot segments", () => {
    expect(isLinkableKey("private/x.pdf")).toBe(false);
    expect(isLinkableKey("home/x.pdf")).toBe(false);
    expect(isLinkableKey("home/attachments/../secret")).toBe(false);
    expect(isLinkableKey("home//x")).toBe(false);
    expect(s3KeyFromLinkPath([])).toBeNull();
    expect(s3KeyFromLinkPath(["..", "x"])).toBeNull();
    expect(() => linkPathForKey("other/x.pdf")).toThrow();
  });

  it("lets the apps link attachments but not vault documents", () => {
    expect(isAppLinkableKey(att)).toBe(true);
    expect(isAppLinkableKey("home/messages/inbound/m1.jpg")).toBe(true);
    expect(isAppLinkableKey(doc)).toBe(false);
    expect(isAppLinkableKey("home/finance/paystubs/x.pdf")).toBe(false);
    expect(isAppLinkableKey("home/attachments/../documents/x.pdf")).toBe(false);
  });

  it("verifies a token for its key until it expires", () => {
    const t = signFileLinkToken(doc, key, { ttlMs: 15 * 60_000, now: NOW });
    expect(t.length).toBeLessThan(32);
    expect(verifyFileLinkToken(doc, t, key, NOW)).toEqual({ ok: true, expiresAt: Math.floor((NOW + 15 * 60_000) / 1000) * 1000 });
    expect(verifyFileLinkToken(doc, t, key, NOW + 14 * 60_000).ok).toBe(true);
    expect(verifyFileLinkToken(doc, t, key, NOW + 15 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing, malformed, swapped and forged tokens", () => {
    const t = signFileLinkToken(doc, key, { ttlMs: 60_000, now: NOW });
    expect(verifyFileLinkToken(doc, undefined, key, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(verifyFileLinkToken(doc, "", key, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(verifyFileLinkToken(doc, "garbage", key, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyFileLinkToken(att, t, key, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyFileLinkToken(doc, t, other, NOW)).toEqual({ ok: false, reason: "invalid" });
    // Pushing the expiry out breaks the signature.
    const [, sig] = t.split(".");
    const later = Math.floor((NOW + 86_400_000) / 1000).toString(36);
    expect(verifyFileLinkToken(doc, `${later}.${sig}`, key, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("builds the full URL", () => {
    const url = signedFileLink(doc, key, { ttlMs: 60_000, now: NOW });
    expect(url).toMatch(/^https:\/\/home\.cristinegennaro\.com\/api\/d\/7f0c2a9e-1b2c-4d5e-8f90-123456789abc\.pdf\?t=[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    const t = new URL(url).searchParams.get("t");
    expect(verifyFileLinkToken(doc, t, key, NOW).ok).toBe(true);
    expect(signedFileLink(att, key, { ttlMs: 60_000, now: NOW, baseUrl: "http://localhost:3001" })).toMatch(
      /^http:\/\/localhost:3001\/api\/d\/attachments\/task\/t1\/a1\.jpg\?t=/,
    );
  });
});
