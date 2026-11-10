// How people relate to each other (homePersonRelationship). One row per
// pair, read as "personId is <kind> of relatedPersonId"; the other
// direction is derived, never stored, so the two sides can't disagree.
//
// Kinds are gender-neutral (PARENT / CHILD); the optional `label` and
// `inverseLabel` carry the word for each side ("mother", "son",
// "mother-in-law"). Inverse kinds are normalized away on save: "Eva is
// Priscilla's CHILD (son)" is stored as Priscilla PARENT of Eva with
// inverseLabel "son".

export const RELATION_KINDS = [
  "SPOUSE",
  "PARTNER",
  "PARENT",
  "CHILD",
  "SIBLING",
  "GRANDPARENT",
  "GRANDCHILD",
  "AUNT_UNCLE",
  "NIECE_NEPHEW",
  "COUSIN",
  "IN_LAW",
  "GODPARENT",
  "GODCHILD",
  "FRIEND",
  "OTHER",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Each kind's inverse; symmetric kinds are their own. */
const INVERSE: Record<RelationKind, RelationKind> = {
  SPOUSE: "SPOUSE",
  PARTNER: "PARTNER",
  PARENT: "CHILD",
  CHILD: "PARENT",
  SIBLING: "SIBLING",
  GRANDPARENT: "GRANDCHILD",
  GRANDCHILD: "GRANDPARENT",
  AUNT_UNCLE: "NIECE_NEPHEW",
  NIECE_NEPHEW: "AUNT_UNCLE",
  COUSIN: "COUSIN",
  IN_LAW: "IN_LAW",
  GODPARENT: "GODCHILD",
  GODCHILD: "GODPARENT",
  FRIEND: "FRIEND",
  OTHER: "OTHER",
};

/** Kinds stored as-is; their inverses are stored swapped. */
const STORED = new Set<RelationKind>(["SPOUSE", "PARTNER", "PARENT", "SIBLING", "GRANDPARENT", "AUNT_UNCLE", "COUSIN", "IN_LAW", "GODPARENT", "FRIEND", "OTHER"]);

export const RELATION_LABELS: Record<RelationKind, string> = {
  SPOUSE: "spouse",
  PARTNER: "partner",
  PARENT: "parent",
  CHILD: "child",
  SIBLING: "sibling",
  GRANDPARENT: "grandparent",
  GRANDCHILD: "grandchild",
  AUNT_UNCLE: "aunt / uncle",
  NIECE_NEPHEW: "niece / nephew",
  COUSIN: "cousin",
  IN_LAW: "in-law",
  GODPARENT: "godparent",
  GODCHILD: "godchild",
  FRIEND: "friend",
  OTHER: "related",
};

export function inverseKind(k: RelationKind): RelationKind {
  return INVERSE[k];
}

export interface RelationshipRow {
  id: string;
  personId: string;
  relatedPersonId: string;
  kind: string;
  label?: string | null;
  inverseLabel?: string | null;
}

export interface RelationshipInput {
  personId: string;
  relatedPersonId: string;
  kind: RelationKind;
  label?: string | null; // word for personId
  inverseLabel?: string | null; // word for relatedPersonId
}

/** The stored form: an inverse kind becomes its forward kind with the people (and words) swapped. */
export function normalizeRelationship(r: RelationshipInput): RelationshipInput {
  if (STORED.has(r.kind)) return r;
  return { personId: r.relatedPersonId, relatedPersonId: r.personId, kind: INVERSE[r.kind], label: r.inverseLabel ?? null, inverseLabel: r.label ?? null };
}

/** The row linking two people, in either direction. One relationship per pair. */
export function findPairRow<R extends RelationshipRow>(rows: R[], a: string, b: string): R | undefined {
  return rows.find((r) => (r.personId === a && r.relatedPersonId === b) || (r.personId === b && r.relatedPersonId === a));
}

export interface RelationView {
  relationshipId: string;
  otherPersonId: string;
  /** What the other person is to this one. */
  kind: RelationKind;
  /** Display word: the row's own word for that side, else the kind's. */
  role: string;
}

/** Everyone related to personId, each with what they are to that person ("Eva: son"). */
export function relationsOf(personId: string, rows: RelationshipRow[]): RelationView[] {
  const out: RelationView[] = [];
  for (const r of rows) {
    const kind = (r.kind in INVERSE ? r.kind : "OTHER") as RelationKind;
    if (r.personId === personId && r.relatedPersonId !== personId) {
      // personId is <kind> of related → related is <inverse> of personId.
      const k = INVERSE[kind];
      out.push({ relationshipId: r.id, otherPersonId: r.relatedPersonId, kind: k, role: r.inverseLabel?.trim() || RELATION_LABELS[k] });
    } else if (r.relatedPersonId === personId && r.personId !== personId) {
      out.push({ relationshipId: r.id, otherPersonId: r.personId, kind, role: r.label?.trim() || RELATION_LABELS[kind] });
    }
  }
  return out;
}
