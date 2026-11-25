// Whose a note is (homeNote.ownerPersonIds). Empty = the household's, so it
// shows for everyone; otherwise it belongs to the people listed. Same rule as
// a task's assignedPersonIds. Shared by the /notes page and list_notes.

export interface NoteOwned {
  ownerPersonIds?: (string | null)[] | null;
}

export function noteOwnerIds(n: NoteOwned): string[] {
  return (n.ownerPersonIds ?? []).filter((x): x is string => !!x);
}

/** A person's view: their notes plus household ones. "all" / null shows every note. */
export function noteVisibleTo(n: NoteOwned, personId: string | null | undefined): boolean {
  if (!personId || personId === "all") return true;
  const owners = noteOwnerIds(n);
  return owners.length === 0 || owners.includes(personId);
}

/** "Household", "Gennaro", "Gennaro and Cristine". Unknown ids are skipped. */
export function noteOwnerLabel(n: NoteOwned, people: { id: string; name: string }[]): string {
  const names = noteOwnerIds(n)
    .map((id) => people.find((p) => p.id === id)?.name)
    .filter((x): x is string => !!x);
  if (!names.length) return "Household";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Whether two notes could be confused for each other by title: both are seen
 * by someone (either is the household's, or they share an owner).
 */
export function ownersOverlap(a: string[], b: string[]): boolean {
  return !a.length || !b.length || a.some((x) => b.includes(x));
}
