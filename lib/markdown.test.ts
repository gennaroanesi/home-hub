import { describe, expect, it } from "vitest";

import { inlineText, parseInline, parseMarkdown, type MdBlock, type MdInline } from "./markdown";

const t = (text: string): MdInline => ({ type: "text", text });

describe("parseInline", () => {
  it("returns plain text as one node", () => {
    expect(parseInline("Cris drives Thursday")).toEqual([t("Cris drives Thursday")]);
  });

  it("parses bold, italic and inline code", () => {
    expect(parseInline("**book** *Dolce* `now`")).toEqual([
      { type: "bold", children: [t("book")] },
      t(" "),
      { type: "italic", children: [t("Dolce")] },
      t(" "),
      { type: "code", text: "now" },
    ]);
    expect(parseInline("__a__ _b_")).toEqual([{ type: "bold", children: [t("a")] }, t(" "), { type: "italic", children: [t("b")] }]);
  });

  it("nests italic inside bold and bold-italic runs", () => {
    expect(parseInline("**a *b* c**")).toEqual([{ type: "bold", children: [t("a "), { type: "italic", children: [t("b")] }, t(" c")] }]);
    expect(parseInline("***x***")).toEqual([{ type: "bold", children: [{ type: "italic", children: [t("x")] }] }]);
    expect(parseInline("*a **b** c*")).toEqual([{ type: "italic", children: [t("a "), { type: "bold", children: [t("b")] }, t(" c")] }]);
  });

  it("leaves stray markers, arithmetic and snake_case alone", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([t("2 * 3 * 4")]);
    expect(parseInline("file_name_here")).toEqual([t("file_name_here")]);
    expect(parseInline("**unclosed")).toEqual([t("**unclosed")]);
    expect(parseInline("a ` b")).toEqual([t("a ` b")]);
  });

  it("does not parse markdown inside code", () => {
    expect(parseInline("`**x**`")).toEqual([{ type: "code", text: "**x**" }]);
  });

  it("parses links, angle autolinks and bare URLs", () => {
    expect(parseInline("see [the vet](https://vet.example.com/a) today")).toEqual([
      t("see "),
      { type: "link", href: "https://vet.example.com/a", children: [t("the vet")] },
      t(" today"),
    ]);
    expect(parseInline("<https://x.io>")).toEqual([{ type: "link", href: "https://x.io", children: [t("https://x.io")] }]);
    expect(parseInline("Menu: https://dolce.example/menu.")).toEqual([
      t("Menu: "),
      { type: "link", href: "https://dolce.example/menu", children: [t("https://dolce.example/menu")] },
      t("."),
    ]);
  });

  it("honors backslash escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([t("*not italic*")]);
  });
});

describe("parseMarkdown", () => {
  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown("\n  \n")).toEqual([]);
  });

  it("splits headings and paragraphs; soft breaks become spaces, hard breaks stay", () => {
    expect(parseMarkdown("# Week\nline one\nline two  \nline three\n\nNext")).toEqual<MdBlock[]>([
      { type: "heading", level: 1, children: [t("Week")] },
      { type: "paragraph", children: [t("line one line two\nline three")] },
      { type: "paragraph", children: [t("Next")] },
    ]);
  });

  it("does not treat a hashtag as a heading", () => {
    expect(parseMarkdown("#dolce")).toEqual([{ type: "paragraph", children: [t("#dolce")] }]);
  });

  it("parses bullet lists with checkboxes and continuation lines", () => {
    expect(parseMarkdown("- [ ] book daycare\n- [x] pay sitter\n  by Friday\n- plain")).toEqual<MdBlock[]>([
      {
        type: "list",
        items: [
          { depth: 0, number: null, checked: false, children: [t("book daycare")] },
          { depth: 0, number: null, checked: true, children: [t("pay sitter by Friday")] },
          { depth: 0, number: null, checked: null, children: [t("plain")] },
        ],
      },
    ]);
  });

  it("numbers ordered lists from their first number and nests by indent", () => {
    const [list] = parseMarkdown("1. one\n1. two\n   - sub a\n   - sub b\n1. three\n\n5. five\n6. six");
    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.items.map((i) => [i.depth, i.number, inlineText(i.children)])).toEqual([
      [0, 1, "one"],
      [0, 2, "two"],
      [1, null, "sub a"],
      [1, null, "sub b"],
      [0, 3, "three"],
      [0, 4, "five"], // a blank line between items keeps the same list
      [0, 5, "six"],
    ]);
  });

  it("lets a list interrupt a paragraph and ends the list at a paragraph after a blank line", () => {
    expect(parseMarkdown("Errands:\n- milk\n\nThat's it").map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
  });

  it("parses rules, quotes and fenced code", () => {
    expect(parseMarkdown("---\n> quoted\n> more\n```\n**raw**\n```\n* * *")).toEqual<MdBlock[]>([
      { type: "rule" },
      { type: "quote", children: [t("quoted more")] },
      { type: "code", text: "**raw**" },
      { type: "rule" },
    ]);
  });

  it("keeps inline formatting inside list items and headings", () => {
    const blocks = parseMarkdown("## **Mon**\n- call [vet](tel:5125550100)");
    expect(blocks[0]).toEqual({ type: "heading", level: 2, children: [{ type: "bold", children: [t("Mon")] }] });
    expect(blocks[1]).toEqual({
      type: "list",
      items: [{ depth: 0, number: null, checked: null, children: [t("call "), { type: "link", href: "tel:5125550100", children: [t("vet")] }] }],
    });
  });
});
