import { describe, expect, it } from "vitest";
import { signApproval, verifyApproval } from "./document-approval";

describe("document approval tokens", () => {
  const a = { txid: "tx1", documentId: "d1", sub: "u1", exp: 2_000 };
  const t = signApproval(a, "k");

  it("round-trips for the same document, caller and time", () => {
    expect(verifyApproval(t, "k", { documentId: "d1", sub: "u1", now: 1_000 })).toEqual(a);
  });

  it("rejects another document, caller, key, expiry or a tampered body", () => {
    expect(verifyApproval(t, "k", { documentId: "d2", sub: "u1", now: 1_000 })).toBeNull();
    expect(verifyApproval(t, "k", { documentId: "d1", sub: "u2", now: 1_000 })).toBeNull();
    expect(verifyApproval(t, "other", { documentId: "d1", sub: "u1", now: 1_000 })).toBeNull();
    expect(verifyApproval(t, "k", { documentId: "d1", sub: "u1", now: 3_000 })).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...a, documentId: "d2" })).toString("base64url") + "." + t.split(".")[1];
    expect(verifyApproval(forged, "k", { documentId: "d2", sub: "u1", now: 1_000 })).toBeNull();
    expect(verifyApproval("junk", "k", { documentId: "d1", sub: "u1", now: 1_000 })).toBeNull();
  });
});
