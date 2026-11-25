import { describe, expect, it } from "vitest";
import { noteSnippet, queryWords, searchNotes } from "./note-search";

const wifi = { id: "w", title: "Wifi", content: "Password for the network is hunter2", updatedAt: "2026-11-01T00:00:00Z" };
const cafe = { id: "c", title: "Places", content: "Café Medici on 12th, the wifi there is good", updatedAt: "2026-11-03T00:00:00Z" };
const misc = { id: "m", title: "Misc", content: "nothing here", updatedAt: "2026-11-05T00:00:00Z" };
const ids = (ns: { id: string }[]) => ns.map((n) => n.id);

describe("searchNotes", () => {
  it("needs every word, in any order, across title and content", () => {
    expect(ids(searchNotes([wifi, cafe, misc], "password wifi"))).toEqual(["w"]);
    expect(ids(searchNotes([wifi, cafe, misc], "wifi nope"))).toEqual([]);
  });

  it("ranks title hits first, then newest", () => {
    expect(ids(searchNotes([wifi, cafe, misc], "wifi"))).toEqual(["w", "c"]);
    expect(ids(searchNotes([wifi, cafe, misc], ""))).toEqual(["m", "c", "w"]);
  });

  it("ignores case, accents and trailing punctuation", () => {
    expect(ids(searchNotes([wifi, cafe], "CAFE"))).toEqual(["c"]);
    expect(ids(searchNotes([wifi, cafe], "café"))).toEqual(["c"]);
    expect(queryWords("wifi? (password)")).toEqual(["wifi", "password"]);
  });

  it("can search extra text such as the parent's name", () => {
    expect(ids(searchNotes([misc], "seattle", () => "Seattle trip"))).toEqual(["m"]);
  });
});

describe("noteSnippet", () => {
  it("shows the content around the first match", () => {
    const long = { content: `${"x ".repeat(200)}the gate code is 4521 ${"y ".repeat(200)}` };
    const s = noteSnippet(long, "gate code")!;
    expect(s).toContain("the gate code is 4521");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });

  it("is null without a query or a content hit", () => {
    expect(noteSnippet(wifi, "")).toBeNull();
    expect(noteSnippet({ title: "Wifi", content: "abc" }, "wifi")).toBeNull();
  });
});
