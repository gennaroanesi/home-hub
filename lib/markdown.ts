// A small markdown parser for the places that render notes without a
// markdown library (the mobile app: week notes today; document, shopping
// and note bodies are candidates). Pure: markdown text in, a simple
// block / inline tree out; each platform renders the tree itself
// (mobile/components/Markdown.tsx).
//
// Covers what household notes realistically use: headings, paragraphs,
// bullet and numbered lists (nested by indent), checkboxes `- [ ]` /
// `- [x]`, block quotes, fenced code, horizontal rules, **bold**,
// *italic*, `inline code`, [links](url) and bare http(s) URLs. Anything
// else falls through as text. Soft line breaks join with a space, as on
// the web; a line ending in two spaces or a backslash keeps its break.

export type MdInline =
  | { type: "text"; text: string }
  | { type: "bold"; children: MdInline[] }
  | { type: "italic"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: MdInline[] };

export interface MdListItem {
  /** 0 for top-level items, +1 per indent level. */
  depth: number;
  /** The number shown for an ordered item; null for bullets. */
  number: number | null;
  /** true / false for `- [x]` / `- [ ]`, null for a plain item. */
  checked: boolean | null;
  children: MdInline[];
}

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "list"; items: MdListItem[] }
  | { type: "quote"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const CHECKBOX = /^\[([ xX])\](?:[ \t]+(.*))?$/;

const indentWidth = (ws: string) => ws.replace(/\t/g, "    ").length;

function startsBlock(line: string): boolean {
  return HEADING.test(line) || RULE.test(line) || FENCE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/** Join source lines into one inline string: a hard break keeps "\n", a soft one becomes a space. */
function joinLines(lines: string[]): string {
  let out = "";
  lines.forEach((raw, i) => {
    const last = i === lines.length - 1;
    const hard = !last && (/ {2,}$/.test(raw) || /\\$/.test(raw));
    const line = (hard ? raw.replace(/(?: {2,}|\\)$/, "") : raw).trim();
    out += line + (last ? "" : hard ? "\n" : " ");
  });
  return out;
}

export function parseMarkdown(src: string | null | undefined): MdBlock[] {
  const lines = (src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1]}`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or past the end)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline((heading[2] ?? "").trim()) });
      i++;
      continue;
    }

    // Before lists: "- - -" and "***" are rules, not items.
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE.exec(lines[i]);
        if (!q && startsBlock(lines[i])) break;
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(joinLines(body)) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const raw: Array<{ indent: number; ordered: boolean; start: number; checked: boolean | null; lines: string[] }> = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_ITEM.exec(l);
        if (m && !RULE.test(l)) {
          let text = m[3] ?? "";
          let checked: boolean | null = null;
          const box = CHECKBOX.exec(text);
          if (box) {
            checked = box[1] !== " ";
            text = box[2] ?? "";
          }
          const ordered = /\d/.test(m[2]);
          raw.push({ indent: indentWidth(m[1]), ordered, start: ordered ? parseInt(m[2], 10) : 0, checked, lines: [text] });
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line keeps the list going only if another item follows.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST_ITEM.test(lines[j]) && !RULE.test(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        // A plain line continues the last item's text (indented or lazy).
        if (startsBlock(l)) break;
        raw[raw.length - 1].lines.push(l);
        i++;
      }

      // Depth from indentation; ordered items count up per level from their first number.
      const stack: number[] = [];
      const counters: Array<number | null> = [];
      const items: MdListItem[] = raw.map((r) => {
        while (stack.length && r.indent < stack[stack.length - 1]) {
          stack.pop();
          counters.pop();
        }
        if (!stack.length || r.indent > stack[stack.length - 1]) {
          stack.push(r.indent);
          counters.push(null);
        }
        const depth = stack.length - 1;
        let number: number | null = null;
        if (r.ordered) {
          number = counters[depth] === null ? r.start : counters[depth]! + 1;
          counters[depth] = number;
        } else {
          counters[depth] = null;
        }
        return { depth, number, checked: r.checked, children: parseInline(joinLines(r.lines)) };
      });
      blocks.push({ type: "list", items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
    blocks.push({ type: "paragraph", children: parseInline(joinLines(para)) });
  }

  return blocks;
}

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);
const isSpace = (c: string | undefined) => !c || /\s/.test(c);

/** Index of the closing `delim` for an opener at `from`, or -1. Content must be non-empty and not padded with spaces. */
function findClose(s: string, from: number, delim: string): number {
  let j = s.indexOf(delim, from + 1);
  while (j !== -1) {
    // Take the end of a run ("***" closes "**" one char later) so bold-italic nests.
    while (delim.length === 2 && s[j + 2] === delim[0]) j++;
    const single = delim.length === 1;
    const okRun = !single || (s[j + 1] !== delim && s[j - 1] !== delim);
    if (j > from && okRun && !isSpace(s[j - 1]) && !(delim[0] === "_" && isWordChar(s[j + delim.length]))) return j;
    j = s.indexOf(delim, j + 1);
  }
  return -1;
}

export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === "\\" && i + 1 < s.length && /[\\`*_[\]()#+\-.!>~]/.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      const end = s.indexOf(ticks, i + run);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: s.slice(i + run, end).replace(/^ (.+) $/, "$1") });
        i = end + run;
        continue;
      }
      text += ticks;
      i += run;
      continue;
    }

    if ((c === "*" || c === "_") && s[i + 1] === c && !isSpace(s[i + 2]) && !(c === "_" && isWordChar(s[i - 1]))) {
      const end = findClose(s, i + 2, c + c);
      if (end !== -1) {
        flush();
        out.push({ type: "bold", children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if ((c === "*" || c === "_") && s[i + 1] !== c && !isSpace(s[i + 1]) && !(c === "_" && isWordChar(s[i - 1]))) {
      const end = findClose(s, i + 1, c);
      if (end !== -1) {
        flush();
        out.push({ type: "italic", children: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const close = s.indexOf("]", i + 1);
      if (close !== -1 && s[close + 1] === "(") {
        const end = s.indexOf(")", close + 2);
        if (end !== -1) {
          const href = s.slice(close + 2, end).trim().replace(/^<(.*)>$/, "$1").split(/\s+/)[0];
          if (href) {
            flush();
            const label = s.slice(i + 1, close);
            out.push({ type: "link", href, children: label ? parseInline(label) : [{ type: "text", text: href }] });
            i = end + 1;
            continue;
          }
        }
      }
    }

    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ type: "link", href: m[1], children: [{ type: "text", text: m[1].replace(/^mailto:/, "") }] });
        i += m[0].length;
        continue;
      }
    }

    if ((c === "h" || c === "H") && !isWordChar(s[i - 1])) {
      const m = /^https?:\/\/[^\s<]+/i.exec(s.slice(i));
      if (m) {
        // Trailing punctuation belongs to the sentence, not the URL.
        const url = m[0].replace(/[.,;:!?'")\]]+$/, "");
        flush();
        out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

/** The plain text of an inline tree (for accessibility labels, previews). */
export function inlineText(nodes: MdInline[]): string {
  return nodes.map((n) => (n.type === "text" || n.type === "code" ? n.text : inlineText(n.children))).join("");
}
