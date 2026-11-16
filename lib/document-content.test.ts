import { describe, expect, it, vi } from "vitest";
import { DUO_TIMEOUT_MESSAGE, fetchDocumentContent, type ContentFetch } from "./document-content";

type Step = { status: number; body?: unknown; badJson?: boolean };

function scripted(steps: Step[]) {
  const calls: { path: string; init?: Parameters<ContentFetch>[1] }[] = [];
  const fetch: ContentFetch = async (path, init) => {
    calls.push({ path, init });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected call ${path}`);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => {
        if (step.badJson) throw new SyntaxError("not json");
        return step.body;
      },
    };
  };
  return { fetch, calls };
}

// Fake clock: each sleep advances it.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("fetchDocumentContent", () => {
  it("returns straight away for a non-sensitive document", async () => {
    const { fetch, calls } = scripted([{ status: 200, body: { url: "https://s3/x" } }]);
    const r = await fetchDocumentContent("d1", { fetch, download: true });
    expect(r).toEqual({ ok: true, content: { url: "https://s3/x" } });
    expect(calls.map((c) => c.path)).toEqual(["/api/documents/d1/content?download=1"]);
  });

  it("asks for approval, polls with the header while waiting, then releases", async () => {
    const { fetch, calls } = scripted([
      { status: 403, body: { error: "duo_required" } },
      { status: 202, body: { approval: "tok", duoUsername: "gennaro" } },
      { status: 202, body: { status: "waiting" } },
      { status: 200, body: { documentNumber: "123" } },
    ]);
    const onDuoPush = vi.fn();
    const r = await fetchDocumentContent("d1", { fetch, onDuoPush, ...clock() });
    expect(r).toEqual({ ok: true, content: { documentNumber: "123" } });
    expect(onDuoPush).toHaveBeenCalledWith("gennaro");
    expect(calls[1]).toEqual({ path: "/api/documents/d1/approval", init: { method: "POST" } });
    expect(calls[2].init?.headers).toEqual({ "X-Document-Approval": "tok" });
    expect(calls[3].path).toBe("/api/documents/d1/content");
  });

  it("reports a denied push", async () => {
    const { fetch } = scripted([
      { status: 403, body: { error: "duo_required" } },
      { status: 202, body: { approval: "tok" } },
      { status: 403, body: { error: "Duo push deny: Login request denied." } },
    ]);
    const r = await fetchDocumentContent("d1", { fetch, ...clock() });
    expect(r).toEqual({ ok: false, reason: "denied", error: "Duo push deny: Login request denied." });
  });

  it("times out after the deadline", async () => {
    const steps: Step[] = [
      { status: 403, body: { error: "duo_required" } },
      { status: 202, body: { approval: "tok" } },
    ];
    for (let i = 0; i < 10; i++) steps.push({ status: 202, body: { status: "waiting" } });
    const { fetch, calls } = scripted(steps);
    const r = await fetchDocumentContent("d1", { fetch, timeoutMs: 10_000, intervalMs: 2000, ...clock() });
    expect(r).toEqual({ ok: false, reason: "timeout", error: DUO_TIMEOUT_MESSAGE });
    expect(calls).toHaveLength(2 + 5);
  });

  it("refetches without a push when the approval says it isn't sensitive any more", async () => {
    const { fetch } = scripted([
      { status: 403, body: { error: "duo_required" } },
      { status: 200, body: { approval: null } },
      { status: 200, body: { url: "u" } },
    ]);
    const onDuoPush = vi.fn();
    const r = await fetchDocumentContent("d1", { fetch, onDuoPush });
    expect(r).toEqual({ ok: true, content: { url: "u" } });
    expect(onDuoPush).not.toHaveBeenCalled();
  });

  it("surfaces other errors, including non-JSON gateway responses", async () => {
    const notFound = scripted([{ status: 404, body: { error: "No such document" } }]);
    expect(await fetchDocumentContent("d1", { fetch: notFound.fetch })).toEqual({ ok: false, reason: "error", error: "No such document" });

    const gateway = scripted([{ status: 504, badJson: true }]);
    const r = await fetchDocumentContent("d1", { fetch: gateway.fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Timed out waiting for Duo approval/);

    const noDuo = scripted([
      { status: 403, body: { error: "duo_required" } },
      { status: 403, body: { error: "Link your Duo account in /security first." } },
    ]);
    expect(await fetchDocumentContent("d1", { fetch: noDuo.fetch })).toEqual({
      ok: false,
      reason: "error",
      error: "Link your Duo account in /security first.",
    });
  });
});
