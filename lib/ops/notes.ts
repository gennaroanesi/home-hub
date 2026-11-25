// Notes: free-form markdown, standalone (lists of stuff, reference info) or
// attached to a task, event, trip, medical visit or health provider. Each
// belongs to the household (no owners) or to some of its members
// (ownerPersonIds, lib/note-owners.ts).

import { z } from "zod/v4";
import { householdMembers } from "../household";
import { listAllPages } from "../list-all";
import { noteOwnerIds, noteVisibleTo, ownersOverlap } from "../note-owners";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

const PARENT_TYPES = ["TASK", "EVENT", "TRIP", "VISIT", "PROVIDER"] as const;

const NoteOut = z.object({
  id: z.string(),
  title: z.string().nullable(),
  content: z.string().describe("Markdown"),
  parentType: z.string().nullable().describe("What it's attached to; null for a standalone note"),
  parentId: z.string().nullable(),
  createdBy: z.string().nullable(),
  ownerPersonIds: z.array(z.string()).describe("[] = a household note"),
  owners: z.array(z.string()).describe("Owners' names; [] = household"),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

type Member = { id: string; name: string; cognitoUsername?: string | null; active?: boolean | null; groups?: (string | null)[] | null };

const household = async (ctx: OpContext) => householdMembers(await listAllPages<Member>(ctx.client.models.homePerson));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function noteForApi(n: any, folks: Member[]): z.infer<typeof NoteOut> {
  const ownerPersonIds = noteOwnerIds(n);
  return {
    id: n.id,
    title: n.title ?? null,
    content: n.content,
    parentType: n.parentType ?? null,
    parentId: n.parentId ?? null,
    createdBy: n.createdBy ?? null,
    ownerPersonIds,
    owners: ownerPersonIds.map((id) => folks.find((p) => p.id === id)?.name ?? id),
    createdAt: n.createdAt ?? null,
    updatedAt: n.updatedAt ?? null,
  };
}

const allNotes = (ctx: OpContext) => listAllPages<any>(ctx.client.models.homeNote); // eslint-disable-line @typescript-eslint/no-explicit-any

function memberById(folks: Member[], id: string): Member {
  const p = folks.find((x) => x.id === id);
  if (!p) throw new OpError(`No household member with id ${id}`);
  return p;
}

function memberByName(folks: Member[], name: string): Member {
  const p = folks.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!p) throw new OpError(`No household member named "${name}". Household: ${folks.map((x) => x.name).join(", ")}`);
  return p;
}

/** ownerPersonIds / ownerNames → ids; "household" or "everyone" alone means [] (a household note). undefined = not given. */
function ownerIdsFrom(folks: Member[], ids: string[] | undefined, names: string[] | undefined): string[] | undefined {
  if (ids === undefined && names === undefined) return undefined;
  const out = (ids ?? []).map((id) => memberById(folks, id).id);
  for (const n of names ?? []) {
    const want = n.trim().toLowerCase();
    if (want === "household" || want === "everyone") continue;
    if (want === "both") {
      // The adults: a kid in the household has no login.
      const adults = folks.filter((p) => p.cognitoUsername);
      out.push(...(adults.length ? adults : folks).map((p) => p.id));
      continue;
    }
    out.push(memberByName(folks, n).id);
  }
  const unique = [...new Set(out)];
  // Every member owning it is the same as the household owning it.
  return folks.length > 1 && folks.every((p) => unique.includes(p.id)) ? [] : unique;
}

export const listNotes = defineOp({
  name: "list_notes",
  domain: "notes",
  access: "read",
  description:
    "Search the household's notes, most recently edited first, with their full markdown content. Notes are standalone (lists and reference info, e.g. a list of clothing stores) or attached to a task, event, trip, medical visit or health provider. Each is the household's (owners empty) or belongs to some members. Answers 'what's on my clothing stores list?', 'do we have a note about the wifi?', 'what notes are on the Seattle trip?'. personId / personName narrows to that person's notes plus the household's (for 'my notes', pass the speaker). Use query to find a note by words in its title or content; use it before save_note to get the noteId.",
  input: z.object({
    noteId: z.string().optional().describe("Return just this note."),
    query: z.string().optional().describe("Words that must all appear in the title or content."),
    standalone: z.boolean().optional().describe("true = only notes not attached to anything."),
    parentType: z.enum(PARENT_TYPES).optional(),
    parentId: z.string().optional(),
    personId: z.string().optional().describe("Only this member's notes and the household's."),
    personName: z.string().optional().describe("Same as personId, by name."),
    limit: z.number().int().min(1).max(200).optional().describe("Max notes returned, default 50."),
  }),
  output: z.object({
    count: z.number().describe("Matches before the limit"),
    notes: z.array(NoteOut),
  }),
  async run(ctx, input) {
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const folks = await household(ctx);
    const person = input.personId ? memberById(folks, input.personId) : input.personName ? memberByName(folks, input.personName) : null;
    const out = (await allNotes(ctx)).filter((n) => {
      if (input.noteId && n.id !== input.noteId) return false;
      if (person && !noteVisibleTo(n, person.id)) return false;
      if (input.standalone && n.parentId) return false;
      if (input.parentType && n.parentType !== input.parentType) return false;
      if (input.parentId && n.parentId !== input.parentId) return false;
      const hay = `${n.title ?? ""} ${n.content ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    out.sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
    return { count: out.length, notes: out.slice(0, input.limit ?? 50).map((n) => noteForApi(n, folks)) };
  },
});

export const saveNote = defineOp({
  name: "save_note",
  domain: "notes",
  access: "write",
  description:
    "Create a note or change one. Without noteId it creates a note (content required), standalone unless parentType and parentId are given. With noteId it updates what's given: appendText adds a new line at the end, which is how to add to a list without retyping it; content replaces the whole note; title renames it (null clears it); ownerNames / ownerPersonIds says whose it is (replaces the owners; [] or ['household'] makes it the household's, which is the default on create; 'both' = the adults). On create it refuses a standalone note whose title already exists for the same people and returns that note; add to it with noteId and appendText, or pass allowDuplicate. For 'add X to my Y list': find the note with list_notes, then call this with noteId and appendText (e.g. '- X' for a bullet list). Content is markdown.",
  input: z.object({
    noteId: z.string().optional().describe("Note to update. Leave out to create."),
    title: z.string().nullable().optional().describe("Optional headline."),
    content: z.string().optional().describe("Markdown. Replaces the whole note when updating."),
    appendText: z.string().optional().describe("Added on a new line at the end of the note."),
    parentType: z.enum(PARENT_TYPES).optional().describe("Attach a new note to this kind of record. Needs parentId."),
    parentId: z.string().optional().describe("Record to attach a new note to. Needs parentType."),
    ownerPersonIds: z.array(z.string()).optional().describe("Whose note, by id. [] = household. Replaces the owners."),
    ownerNames: z.array(z.string()).optional().describe("Whose note, by name ('both' = the adults, 'household' = everyone's). Replaces the owners."),
    allowDuplicate: z.boolean().optional().describe("Create even if a standalone note already has this title."),
  }),
  output: z.object({
    action: z.enum(["created", "updated"]),
    note: NoteOut,
  }),
  async run(ctx, input) {
    const title = input.title === undefined ? undefined : input.title?.trim() || null;
    if (input.content !== undefined && input.appendText !== undefined) {
      throw new OpError("Send content to replace the note or appendText to add to it, not both");
    }
    if (input.content !== undefined && !input.content.trim()) throw new OpError("A note can't be empty");
    const append = input.appendText?.trim();
    if (input.appendText !== undefined && !append) throw new OpError("appendText is empty");
    const folks = await household(ctx);
    const owners = ownerIdsFrom(folks, input.ownerPersonIds, input.ownerNames);

    if (input.noteId) {
      if (input.parentType || input.parentId) throw new OpError("A note's parent can't be changed");
      const { data: existing } = await ctx.client.models.homeNote.get({ id: input.noteId });
      if (!existing) throw new OpError(`No note ${input.noteId}. Use list_notes to find the id.`);
      const content = append ? `${existing.content.replace(/\s+$/, "")}\n${append}` : input.content;
      if (content === undefined && title === undefined && owners === undefined) throw new OpError("Nothing to change");
      const r = await ctx.client.models.homeNote.update({
        id: existing.id,
        ...(content !== undefined ? { content } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(owners !== undefined ? { ownerPersonIds: owners } : {}),
      });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      return { action: "updated" as const, note: noteForApi(r.data, folks) };
    }

    const content = input.content ?? append;
    if (!content) throw new OpError("content is required to create a note");
    if (!input.parentType !== !input.parentId) throw new OpError("parentType and parentId must be provided together");
    if (title && !input.parentId && !input.allowDuplicate) {
      // Only a clash if someone would see both: two people can each keep
      // their own "Clothing stores".
      const dup = (await allNotes(ctx)).find(
        (n) => !n.parentId && n.title?.trim().toLowerCase() === title.toLowerCase() && ownersOverlap(noteOwnerIds(n), owners ?? []),
      );
      if (dup) {
        throw new OpError(`There's already a note called "${dup.title}". Add to it with noteId and appendText, or pass allowDuplicate.`, {
          existing: noteForApi(dup, folks),
        });
      }
    }
    const via = ctx.actor.via;
    const r = await ctx.client.models.homeNote.create({
      title: title ?? null,
      content,
      parentType: input.parentType ?? null,
      parentId: input.parentId ?? null,
      ownerPersonIds: owners ?? [],
      createdBy: via === "web" || via === "mobile" ? "ui" : via === "whatsapp" ? "agent" : via,
    });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    return { action: "created" as const, note: noteForApi(r.data, folks) };
  },
});

export const notesOps = [listNotes, saveNote];
