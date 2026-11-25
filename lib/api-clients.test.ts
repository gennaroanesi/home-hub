import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, matchApiClient, parseApiClients, type ApiClient } from "./api-clients";

const museKey = "muse-secret";
const svcKey = generateApiKey();
const clients: ApiClient[] = [
  { name: "muse", keyHash: hashApiKey(museKey), sender: "Gennaro" },
  { name: "svc", keyHash: hashApiKey(svcKey), sender: "Cristine" },
  { name: "old", keyHash: hashApiKey("old-key"), sender: "Gennaro", disabledAt: "2026-11-01T00:00:00Z" },
];

describe("matchApiClient", () => {
  it("finds the client a key belongs to", () => {
    expect(matchApiClient(museKey, clients)?.name).toBe("muse");
    expect(matchApiClient(svcKey, clients)?.sender).toBe("Cristine");
  });

  it("rejects unknown, empty and revoked keys", () => {
    expect(matchApiClient("nope", clients)).toBeNull();
    expect(matchApiClient("", clients)).toBeNull();
    expect(matchApiClient("old-key", clients)).toBeNull();
  });
});

describe("parseApiClients", () => {
  it("reads the secret and drops malformed entries", () => {
    const raw = JSON.stringify({
      clients: [
        clients[0],
        { name: "nohash", sender: "x" },
        { name: "badhash", keyHash: "abc", sender: "x" },
        { name: "nosender", keyHash: hashApiKey("k") },
      ],
    });
    expect(parseApiClients(raw).map((c) => c.name)).toEqual(["muse"]);
  });

  it("treats missing or broken JSON as no clients", () => {
    expect(parseApiClients(undefined)).toEqual([]);
    expect(parseApiClients("{")).toEqual([]);
    expect(parseApiClients('{"clients": 3}')).toEqual([]);
  });
});

it("generates distinct prefixed keys", () => {
  const a = generateApiKey();
  expect(a).toMatch(/^hh_[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(generateApiKey());
});
