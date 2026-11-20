// Reviewing the family graph (homePersonRelationship): words that are
// missing or don't fit, and relationships the existing ones imply. Pure;
// scripts/review-relationships.ts prints the review and applies what's
// picked through save_relationship.
//
// People have no gender field, so it's read from the words already used
// for them ("son" in one row makes him "brother" in another and lets his
// mother's row say "son" too). A person called both "son" and "daughter"
// is reported, not guessed.

import { RELATION_LABELS, findPairRow, inverseKind, normalizeRelationship, type RelationKind, type RelationshipRow } from "./relationships";

export type Gender = "m" | "f";

/** The gendered word for a kind (what the person *is*), when there is one. */
const WORDS: Partial<Record<RelationKind, Record<Gender, string>>> = {
  SPOUSE: { m: "husband", f: "wife" },
  PARENT: { m: "father", f: "mother" },
  CHILD: { m: "son", f: "daughter" },
  SIBLING: { m: "brother", f: "sister" },
  GRANDPARENT: { m: "grandfather", f: "grandmother" },
  GRANDCHILD: { m: "grandson", f: "granddaughter" },
  AUNT_UNCLE: { m: "uncle", f: "aunt" },
  NIECE_NEPHEW: { m: "nephew", f: "niece" },
  GODPARENT: { m: "godfather", f: "godmother" },
  GODCHILD: { m: "godson", f: "goddaughter" },
  PARTNER: { m: "boyfriend", f: "girlfriend" },
};

const MALE = new Set(["husband", "father", "dad", "son", "brother", "grandfather", "grandpa", "grandson", "uncle", "nephew", "godfather", "godson", "boyfriend", "father-in-law", "son-in-law", "brother-in-law", "stepfather", "stepson", "stepbrother"]);
const FEMALE = new Set(["wife", "mother", "mom", "daughter", "sister", "grandmother", "grandma", "granddaughter", "aunt", "niece", "godmother", "goddaughter", "girlfriend", "mother-in-law", "daughter-in-law", "sister-in-law", "stepmother", "stepdaughter", "stepsister"]);

export function genderOfWord(word: string | null | undefined): Gender | null {
  const w = (word ?? "").trim().toLowerCase();
  return MALE.has(w) ? "m" : FEMALE.has(w) ? "f" : null;
}

export function wordFor(kind: RelationKind, gender: Gender | null | undefined): string | null {
  return gender ? (WORDS[kind]?.[gender] ?? null) : null;
}

/** Words that fit a kind, any gender (and the kind's own neutral word). */
function wordsOfKind(kind: RelationKind): Set<string> {
  const w = WORDS[kind];
  return new Set([RELATION_LABELS[kind], ...(w ? [w.m, w.f] : [])]);
}

type Kinded = RelationshipRow & { kind: RelationKind };
const asKind = (k: string): RelationKind => (k in RELATION_LABELS ? (k as RelationKind) : "OTHER");

/** Each person's gender as the words about them say; "conflict" when they disagree. */
export function inferGenders(rows: RelationshipRow[]): Map<string, Gender | "conflict"> {
  const seen = new Map<string, Set<Gender>>();
  const note = (id: string, word: string | null | undefined) => {
    const g = genderOfWord(word);
    if (!g) return;
    seen.set(id, new Set([...(seen.get(id) ?? []), g]));
  };
  for (const r of rows) {
    note(r.personId, r.label);
    note(r.relatedPersonId, r.inverseLabel);
  }
  return new Map([...seen].map(([id, gs]) => [id, gs.size > 1 ? "conflict" : [...gs][0]]));
}

export type WordFix = {
  relationshipId: string;
  kind: RelationKind;
  personId: string;
  relatedPersonId: string;
  label: string | null;
  inverseLabel: string | null;
  /** What changed, e.g. "Gio: child → son". */
  changes: string[];
};

export type Conflict = { personId: string; note: string };

/**
 * Words to fill in or fix: a side with no word gets its gendered word when
 * the person's gender is known; a word that belongs to another kind
 * ("sister" on a PARENT row) is replaced the same way, or reported.
 */
export function reviewWords(rows: RelationshipRow[], names: Map<string, string>): { fixes: WordFix[]; conflicts: Conflict[] } {
  const genders = inferGenders(rows);
  const conflicts: Conflict[] = [...genders].filter(([, g]) => g === "conflict").map(([id]) => ({ personId: id, note: `${names.get(id) ?? id} is called both a man's and a woman's word; fix one by hand` }));
  const gender = (id: string) => {
    const g = genders.get(id);
    return g === "conflict" ? null : (g ?? null);
  };
  const fixes: WordFix[] = [];
  for (const raw of rows) {
    const r: Kinded = { ...raw, kind: asKind(raw.kind) };
    const sides = [
      { id: r.personId, kind: r.kind, word: r.label ?? null },
      { id: r.relatedPersonId, kind: inverseKind(r.kind), word: r.inverseLabel ?? null },
    ];
    const next = sides.map((s) => {
      const want = wordFor(s.kind, gender(s.id));
      const have = s.word?.trim().toLowerCase() || null;
      if (!have) return want ? { word: want, change: `${names.get(s.id)}: ${RELATION_LABELS[s.kind]} → ${want}` } : null;
      // In-law and step words carry their own meaning; leave them alone.
      if (/-in-law$|^step/.test(have)) return null;
      const fits = wordsOfKind(s.kind).has(have);
      const sameGender = !genderOfWord(have) || !gender(s.id) || genderOfWord(have) === gender(s.id);
      if (fits && sameGender) return null;
      if (want && want !== have) return { word: want, change: `${names.get(s.id)}: ${have} → ${want}` };
      conflicts.push({ personId: s.id, note: `${names.get(s.id)} is "${have}" on a ${RELATION_LABELS[s.kind]} link with ${names.get(s === sides[0] ? r.relatedPersonId : r.personId)}; check it` });
      return null;
    });
    if (!next[0] && !next[1]) continue;
    fixes.push({
      relationshipId: r.id,
      kind: r.kind,
      personId: r.personId,
      relatedPersonId: r.relatedPersonId,
      label: next[0]?.word ?? r.label ?? null,
      inverseLabel: next[1]?.word ?? r.inverseLabel ?? null,
      changes: [next[0]?.change, next[1]?.change].filter((x): x is string => !!x),
    });
  }
  return { fixes, conflicts };
}

export type Suggestion = {
  personId: string;
  relatedPersonId: string;
  /** What personId is to relatedPersonId (stored form). */
  kind: RelationKind;
  label: string | null;
  inverseLabel: string | null;
  /** Why: "Caroline's cousin, and Cris is Caroline's sibling". */
  reason: string;
  /** "likely" follows from the rows; "maybe" is a guess worth asking about (co-parents with no link). */
  confidence: "likely" | "maybe";
};

/**
 * Relationships the rows imply, for pairs with no row yet: siblings (a
 * shared parent, or a sibling's sibling), grandparents, aunts / uncles,
 * cousins (children of a parent's sibling, or a cousin's sibling), nieces /
 * nephews, in-laws (a spouse's parent or sibling, a sibling's spouse), and
 * co-parents with no link between them.
 */
export function suggestRelationships(rows: RelationshipRow[], names: Map<string, string>): Suggestion[] {
  const genders = inferGenders(rows);
  const gender = (id: string) => {
    const g = genders.get(id);
    return g === "conflict" ? null : (g ?? null);
  };
  const views = rows.map((r) => ({ ...r, kind: asKind(r.kind) }));
  // a is <kind> of b, both directions.
  const edges: Array<{ a: string; b: string; kind: RelationKind }> = views.flatMap((r) => [
    { a: r.personId, b: r.relatedPersonId, kind: r.kind },
    { a: r.relatedPersonId, b: r.personId, kind: inverseKind(r.kind) },
  ]);
  const whoAre = (kind: RelationKind, of: string) => edges.filter((e) => e.kind === kind && e.b === of).map((e) => e.a);
  const parentsOf = (x: string) => whoAre("PARENT", x);
  const childrenOf = (x: string) => whoAre("CHILD", x);
  const siblingsOf = (x: string) => whoAre("SIBLING", x);
  const spousesOf = (x: string) => [...whoAre("SPOUSE", x), ...whoAre("PARTNER", x)];
  const cousinsOf = (x: string) => whoAre("COUSIN", x);
  const people = [...new Set(edges.flatMap((e) => [e.a, e.b]))];
  const n = (id: string) => names.get(id) ?? id;

  const out = new Map<string, Suggestion>();
  const propose = (a: string, b: string, kind: RelationKind, reason: string, confidence: Suggestion["confidence"] = "likely", words?: { a?: string | null; b?: string | null }) => {
    if (a === b || findPairRow(rows, a, b)) return;
    const key = [a, b].sort().join("|");
    if (out.has(key)) return;
    const s = normalizeRelationship({
      personId: a,
      relatedPersonId: b,
      kind,
      label: words?.a !== undefined ? words.a : wordFor(kind, gender(a)),
      inverseLabel: words?.b !== undefined ? words.b : wordFor(inverseKind(kind), gender(b)),
    });
    out.set(key, { personId: s.personId, relatedPersonId: s.relatedPersonId, kind: s.kind, label: s.label ?? null, inverseLabel: s.inverseLabel ?? null, reason, confidence });
  };
  const inLaw = (base: "father" | "mother" | "son" | "daughter" | "brother" | "sister" | null) => (base ? `${base}-in-law` : null);
  const g2 = <T,>(g: Gender | null, m: T, f: T) => (g === "m" ? m : g === "f" ? f : null);

  for (const x of people) {
    for (const p of parentsOf(x)) {
      for (const sib of childrenOf(p)) propose(sib, x, "SIBLING", `both ${n(p)}'s children`);
      for (const gp of parentsOf(p)) propose(gp, x, "GRANDPARENT", `${n(p)}'s parent, and ${n(p)} is ${n(x)}'s parent`);
      for (const au of siblingsOf(p)) {
        propose(au, x, "AUNT_UNCLE", `${n(p)}'s sibling, and ${n(p)} is ${n(x)}'s parent`);
        for (const c of childrenOf(au)) propose(c, x, "COUSIN", `${n(au)}'s child, and ${n(au)} is ${n(x)}'s ${g2(gender(au), "uncle", "aunt") ?? "aunt / uncle"}`);
      }
    }
    for (const s of siblingsOf(x)) {
      for (const s2 of siblingsOf(s)) propose(s2, x, "SIBLING", `${n(s)}'s sibling, and ${n(s)} is ${n(x)}'s sibling`);
      for (const c of cousinsOf(s)) propose(c, x, "COUSIN", `${n(s)}'s cousin, and ${n(x)} is ${n(s)}'s ${wordFor("SIBLING", gender(x)) ?? "sibling"}`);
      for (const kid of childrenOf(s)) propose(x, kid, "AUNT_UNCLE", `${n(kid)} is ${n(s)}'s child, and ${n(s)} is ${n(x)}'s sibling`);
      // A sibling's spouse: brother- / sister-in-law.
      for (const sp of spousesOf(s)) propose(sp, x, "IN_LAW", `${n(s)}'s spouse, and ${n(s)} is ${n(x)}'s sibling`, "likely", { a: inLaw(g2(gender(sp), "brother", "sister")), b: inLaw(g2(gender(x), "brother", "sister")) });
    }
    for (const sp of spousesOf(x)) {
      // A spouse's parent: father- / mother-in-law; a spouse's sibling: brother- / sister-in-law.
      for (const pil of parentsOf(sp)) propose(pil, x, "IN_LAW", `${n(sp)}'s parent, and ${n(sp)} is ${n(x)}'s spouse`, "likely", { a: inLaw(g2(gender(pil), "father", "mother")), b: inLaw(g2(gender(x), "son", "daughter")) });
      for (const sil of siblingsOf(sp)) propose(sil, x, "IN_LAW", `${n(sp)}'s sibling, and ${n(sp)} is ${n(x)}'s spouse`, "likely", { a: inLaw(g2(gender(sil), "brother", "sister")), b: inLaw(g2(gender(x), "brother", "sister")) });
    }
    // Two parents of the same child with nothing between them.
    const ps = parentsOf(x);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) propose(ps[i], ps[j], "SPOUSE", `both ${n(x)}'s parents; spouse or partner?`, "maybe");
  }
  return [...out.values()].sort((a, b) => Number(a.confidence === "maybe") - Number(b.confidence === "maybe") || n(a.personId).localeCompare(n(b.personId)));
}
