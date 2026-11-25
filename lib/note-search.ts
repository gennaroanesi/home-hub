// Note search, shared by the /notes page and list_notes (Janet, hh, the API):
// every word of the query must appear in the title or content (or `extra`,
// e.g. the parent's name on the web), ignoring case and accents. Results rank
// title hits first, then by how many words hit the title, then newest edit.

export interface SearchableNote {
  title?: string | null;
  content?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/** Lowercase, accents off ("café" → "cafe"), so "cafe" finds both. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function queryWords(query: string | null | undefined): string[] {
  return foldText(query ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")) // "wifi?" → "wifi"
    .filter(Boolean);
}

/** 0 = no match; higher = better. With no words everything matches at 1. */
export function noteSearchScore(n: SearchableNote, words: string[], extra = ""): number {
  if (!words.length) return 1;
  const title = foldText(n.title ?? "");
  const hay = `${title}\n${foldText(n.content ?? "")}\n${foldText(extra)}`;
  if (!words.every((w) => hay.includes(w))) return 0;
  const inTitle = words.filter((w) => title.includes(w)).length;
  const phrase = words.join(" ");
  return 1 + inTitle + (words.length > 1 && hay.includes(phrase) ? 1 : 0) + (title === phrase ? 10 : 0);
}

const editedAt = (n: SearchableNote) => n.updatedAt ?? n.createdAt ?? "";

/** Matching notes, best first (newest first among equals; all newest first with no query). */
export function searchNotes<N extends SearchableNote>(notes: N[], query: string | null | undefined, extraOf?: (n: N) => string): N[] {
  const words = queryWords(query);
  return notes
    .map((n) => ({ n, score: noteSearchScore(n, words, extraOf?.(n) ?? "") }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || editedAt(b.n).localeCompare(editedAt(a.n)))
    .map((x) => x.n);
}

/** ~maxLen chars of content around the first query word, on one line; null without a content hit. */
export function noteSnippet(n: SearchableNote, query: string | null | undefined, maxLen = 160): string | null {
  const words = queryWords(query);
  const content = (n.content ?? "").replace(/\s+/g, " ").trim();
  if (!words.length || !content) return null;
  // foldText keeps length for ordinary text; fall back to the start if not.
  const folded = foldText(content);
  const at = Math.min(...words.map((w) => folded.indexOf(w)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return null;
  const start = folded.length === content.length ? Math.max(0, at - Math.floor(maxLen / 3)) : 0;
  const cut = content.slice(start, start + maxLen);
  return `${start > 0 ? "…" : ""}${cut}${start + maxLen < content.length ? "…" : ""}`;
}
