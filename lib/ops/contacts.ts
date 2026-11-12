// Contact book: people who aren't in the household (friends, family,
// people tagged in photos) and businesses / service people. Household
// members are managed on /admin/people and aren't edited here; see
// lib/people.ts and lib/businesses.ts.

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import { BUSINESS_CATEGORIES, businessMatches, businessRow, healthProviderRow } from "../businesses";
import { CIRCLES, daysToBirthday, inHousehold } from "../people";
import { todayIso } from "../finance/dates";
import { originalPhotoUrl, photoUrl } from "../image-loader";
import { RELATION_KINDS, RELATION_LABELS, findPairRow, normalizeRelationship, relationsOf, type RelationshipRow } from "../relationships";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const RelationOut = z.object({
  relationshipId: z.string(),
  personId: z.string().describe("The other person"),
  name: z.string(),
  kind: z.enum(RELATION_KINDS).describe("What the other person is to this one"),
  role: z.string().describe("Display word, e.g. 'daughter' (falls back to the kind)"),
});

const PEOPLE_PREFIX = "home/people/";

const ContactOut = z.object({
  id: z.string(),
  name: z.string(),
  circle: z.string().nullable(),
  birthday: z.string().nullable().describe("YYYY-MM-DD; year 1900 = unknown"),
  daysToBirthday: z.number().nullable(),
  phoneNumber: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  photoUrl: z.string().nullable().describe("Profile picture, resized to 400px wide"),
  photoOriginalUrl: z.string().nullable().describe("Profile picture, full size"),
  relations: z.array(RelationOut).describe("How other people relate to them"),
});


function relationsOut(personId: string, rels: RelationshipRow[], byId: Map<string, any>): z.infer<typeof RelationOut>[] {
  return relationsOf(personId, rels)
    .filter((r) => byId.has(r.otherPersonId))
    .map((r) => ({ relationshipId: r.relationshipId, personId: r.otherPersonId, name: byId.get(r.otherPersonId).name, kind: r.kind, role: r.role }));
}

function contactOut(p: any, today: string, rels: RelationshipRow[] = [], byId: Map<string, any> = new Map()): z.infer<typeof ContactOut> {
  return {
    id: p.id,
    name: p.name,
    circle: p.circle ?? null,
    birthday: p.birthday ?? null,
    daysToBirthday: daysToBirthday(p.birthday, today),
    phoneNumber: p.phoneNumber ?? null,
    email: p.email ?? null,
    notes: p.notes ?? null,
    photoUrl: p.photoKey ? photoUrl(p.photoKey, 400) : null,
    photoOriginalUrl: p.photoKey ? originalPhotoUrl(p.photoKey) : null,
    relations: relationsOut(p.id, rels, byId),
  };
}

const BusinessOut = z.object({
  id: z.string(),
  source: z.enum(["business", "health"]).describe("health = a health provider, edited with the health provider tool"),
  name: z.string(),
  category: z.string().nullable(),
  service: z.string().nullable().describe("What they do for us (health: specialty)"),
  contactName: z.string().nullable().describe("Person to ask for (health: practice)"),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  lastUsedOn: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
});

const allPeople = (ctx: OpContext) => listAllPages<any>(ctx.client.models.homePerson);
const allRelationships = (ctx: OpContext) => listAllPages<RelationshipRow>(ctx.client.models.homePersonRelationship);

/** A person by id, else by exact name (case-insensitive), from anyone in the app. */
function pickPerson(people: any[], id: string | undefined, name: string | undefined, what: string): any {
  if (id) {
    const p = people.find((x) => x.id === id);
    if (!p) throw new OpError(`No person with id ${id}`);
    return p;
  }
  const n = (name ?? "").trim().toLowerCase();
  if (!n) throw new OpError(`Say who the ${what} is: id or name`);
  const p = people.find((x) => x.name.toLowerCase() === n);
  if (!p) throw new OpError(`No person named "${name}"; add them with save_contact first`);
  return p;
}

/** Stores a contact picture from an https link or an API upload; returns its key. */
async function storePhoto(ctx: OpContext, input: { imageUrl?: string; s3Key?: string }): Promise<string> {
  if (input.imageUrl) return ctx.storage.storeFromUrl(input.imageUrl.trim(), PEOPLE_PREFIX);
  return ctx.storage.copyUpload(input.s3Key!.trim(), PEOPLE_PREFIX);
}

export const listContacts = defineOp({
  name: "list_contacts",
  domain: "contacts",
  access: "read",
  description:
    "The contact book's people: friends, family and others who aren't in the household, with circle (family, friends, work), birthday, phone, email and notes. Answers 'when is Marco's birthday?', 'whose birthdays are coming up?', 'what's Ana's number?'. Household members aren't included.",
  input: z.object({
    query: z.string().optional().describe("Words that must all appear in the name, email, phone or notes."),
    circle: z.enum(CIRCLES).optional(),
    upcomingBirthdaysDays: z.number().int().min(0).max(366).optional().describe("Only people whose birthday is within this many days, soonest first."),
  }),
  output: z.object({ contacts: z.array(ContactOut) }),
  async run(ctx, input) {
    const today = todayIso();
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const [people, rels] = await Promise.all([allPeople(ctx), allRelationships(ctx).catch(() => [] as RelationshipRow[])]);
    const byId = new Map(people.map((p) => [p.id, p]));
    let rows = people
      .filter((p) => !inHousehold(p) && p.active !== false)
      .filter((p) => !input.circle || p.circle === input.circle)
      .filter((p) => words.every((w) => [p.name, p.email, p.phoneNumber, p.notes].filter(Boolean).join(" ").toLowerCase().includes(w)))
      .map((p) => contactOut(p, today, rels, byId));
    if (input.upcomingBirthdaysDays != null) {
      rows = rows.filter((c) => c.daysToBirthday != null && c.daysToBirthday <= input.upcomingBirthdaysDays!).sort((a, b) => a.daysToBirthday! - b.daysToBirthday!);
    } else {
      rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { contacts: rows };
  },
});

export const saveContact = defineOp({
  name: "save_contact",
  domain: "contacts",
  access: "write",
  description:
    "Add a person to the contact book or change one. Without contactId it creates one (name required) and refuses a name that already exists. With contactId it updates only what's given; null clears a field. Picture: imageUrl (an https link the server downloads) or s3Key (from POST /uploads after PUTting the image there) sets or replaces it, on create or update; removePhoto clears it. Household members can't be changed here.",
  input: z.object({
    contactId: z.string().optional(),
    name: z.string().optional(),
    circle: z.enum(CIRCLES).nullable().optional(),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("YYYY-MM-DD; use 1900 for an unknown year."),
    phoneNumber: z.string().nullable().optional().describe("E.164, e.g. +15125551234"),
    email: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    imageUrl: z.string().optional().describe("https link to a picture of them; downloaded and stored as their profile picture (JPEG, PNG, WebP, HEIC or GIF, up to 10 MB)."),
    s3Key: z.string().optional().describe("Key returned by POST /uploads after the picture was PUT there; becomes their profile picture."),
    removePhoto: z.boolean().optional().describe("true removes the profile picture."),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), contact: ContactOut }),
  async run(ctx, input) {
    const today = todayIso();
    const fields: Record<string, any> = Object.fromEntries(
      (["name", "circle", "birthday", "phoneNumber", "email", "notes"] as const).filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === "string" ? (input[k] as string).trim() || null : input[k]]),
    );
    const photoSources = [input.imageUrl, input.s3Key, input.removePhoto ? true : undefined].filter((x) => x !== undefined && x !== "");
    if (photoSources.length > 1) throw new OpError("Send one of imageUrl, s3Key or removePhoto");
    if (input.removePhoto && !input.contactId) throw new OpError("removePhoto needs contactId");
    if (input.contactId) {
      const { data: p } = await ctx.client.models.homePerson.get({ id: input.contactId });
      if (!p) throw new OpError(`No contact with id ${input.contactId}`);
      if (inHousehold(p)) throw new OpError(`${p.name} is a household member; change them on the Household page`);
      if ("name" in fields && !fields.name) throw new OpError("name can't be empty");
      if (input.removePhoto) fields.photoKey = null;
      else if (photoSources.length) fields.photoKey = await storePhoto(ctx, input);
      const r = await ctx.client.models.homePerson.update({ id: p.id, ...fields });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "updated" as const, contact: contactOut(r.data, today) };
    }
    const name = (input.name ?? "").trim();
    if (!name) throw new OpError("name is required to add a contact");
    const dup = (await allPeople(ctx)).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new OpError(`${dup.name} is already in the app; pass contactId to change them`, { contactId: dup.id });
    if (photoSources.length) fields.photoKey = await storePhoto(ctx, input);
    const r = await ctx.client.models.homePerson.create({ ...fields, name, active: true, groups: [] });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return { action: "created" as const, contact: contactOut(r.data, today) };
  },
});

export const listBusinesses = defineOp({
  name: "list_businesses",
  domain: "contacts",
  access: "read",
  description:
    "Businesses and service people the household uses (repairs, mechanic, groomer, cleaners…), plus health providers (source 'health'). Answers 'who fixed our dishwasher?', 'what's the plumber's number?', 'who's our vet groomer?'. query matches name, service, contact person, phone, notes and category.",
  input: z.object({
    query: z.string().optional(),
    category: z.enum([...BUSINESS_CATEGORIES, "HEALTH"]).optional(),
    includeInactive: z.boolean().optional(),
  }),
  output: z.object({ businesses: z.array(BusinessOut) }),
  async run(ctx, input) {
    const [biz, health] = await Promise.all([
      listAllPages<any>(ctx.client.models.homeBusiness),
      listAllPages<any>(ctx.client.models.homeHealthProvider).catch(() => []),
    ]);
    const rows = [...biz.map(businessRow), ...health.map(healthProviderRow)]
      .filter((b) => input.includeInactive || b.active)
      .filter((b) => !input.category || b.category === input.category)
      .filter((b) => !input.query || businessMatches(b, input.query))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { businesses: rows };
  },
});

export const saveBusiness = defineOp({
  name: "save_business",
  domain: "contacts",
  access: "write",
  description:
    "Add a business or service person to the contact book, or change one. Without businessId it creates one (name required) and refuses a name that already exists. With businessId it updates only what's given; null clears a field. Use service for what they did for us ('fixed the dishwasher pump') and lastUsedOn for when. Health providers (doctors, labs) are not saved here.",
  input: z.object({
    businessId: z.string().optional(),
    name: z.string().optional(),
    category: z.enum(BUSINESS_CATEGORIES).nullable().optional(),
    service: z.string().nullable().optional(),
    contactName: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    lastUsedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    notes: z.string().nullable().optional(),
    active: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), business: BusinessOut }),
  async run(ctx, input) {
    const keys = ["name", "category", "service", "contactName", "phone", "email", "website", "address", "lastUsedOn", "notes", "active"] as const;
    const fields = Object.fromEntries(
      keys.filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === "string" ? (input[k] as string).trim() || null : input[k]]),
    );
    const model = ctx.client.models.homeBusiness;
    if (input.businessId) {
      const { data: b } = await model.get({ id: input.businessId });
      if (!b) throw new OpError(`No business with id ${input.businessId}`);
      if ("name" in fields && !fields.name) throw new OpError("name can't be empty");
      const r = await model.update({ id: b.id, ...fields });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "updated" as const, business: businessRow(r.data) };
    }
    const name = (input.name ?? "").trim();
    if (!name) throw new OpError("name is required to add a business");
    const dup = (await listAllPages<any>(model)).find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new OpError(`${dup.name} is already saved; pass businessId to change it`, { businessId: dup.id });
    const r = await model.create({ ...fields, name, active: input.active ?? true });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return { action: "created" as const, business: businessRow(r.data) };
  },
});

export const listRelationships = defineOp({
  name: "list_relationships",
  domain: "contacts",
  access: "read",
  description:
    "How people relate to one person, household members included: 'who is Eva's mother?', 'who are Priscilla's kids?', 'how is Gabrielle related to us?'. Each relation says what the other person is to this one (kind, plus role, the word to use, e.g. 'daughter').",
  input: z.object({
    personId: z.string().optional(),
    personName: z.string().optional(),
  }),
  output: z.object({ personId: z.string(), name: z.string(), relations: z.array(RelationOut) }),
  async run(ctx, input) {
    const [people, rels] = await Promise.all([allPeople(ctx), allRelationships(ctx)]);
    const p = pickPerson(people, input.personId, input.personName, "person");
    return { personId: p.id, name: p.name, relations: relationsOut(p.id, rels, new Map(people.map((x) => [x.id, x]))) };
  },
});

export const saveRelationship = defineOp({
  name: "save_relationship",
  domain: "contacts",
  access: "write",
  description:
    "Record how two people relate: '<person> is the <kind> of <relatedPerson>'. The inverse is implied, so record each pair once (Priscilla PARENT of Eva also means Eva is Priscilla's child). label is the word for person, inverseLabel the word for relatedPerson, e.g. person Eva, kind CHILD, relatedPerson Priscilla, label 'daughter'. One relationship per pair: saving a pair that's already linked replaces it. remove: true unlinks the pair. Both people must already exist (household or contacts).",
  input: z.object({
    personId: z.string().optional(),
    personName: z.string().optional(),
    kind: z.enum(RELATION_KINDS).optional().describe("What person is to relatedPerson. Required unless remove."),
    relatedPersonId: z.string().optional(),
    relatedPersonName: z.string().optional(),
    label: z.string().nullable().optional().describe("Word for person, e.g. 'mother', 'daughter', 'mother-in-law'"),
    inverseLabel: z.string().nullable().optional().describe("Word for relatedPerson"),
    remove: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated", "removed", "unchanged"]), summary: z.string() }),
  async run(ctx, input) {
    const [people, rels] = await Promise.all([allPeople(ctx), allRelationships(ctx)]);
    const a = pickPerson(people, input.personId, input.personName, "person");
    const b = pickPerson(people, input.relatedPersonId, input.relatedPersonName, "related person");
    if (a.id === b.id) throw new OpError("A person can't be related to themselves");
    const model = ctx.client.models.homePersonRelationship;
    const existing = findPairRow(rels, a.id, b.id);
    if (input.remove) {
      if (!existing) return { action: "unchanged" as const, summary: `${a.name} and ${b.name} weren't linked` };
      await model.delete({ id: existing.id });
      return { action: "removed" as const, summary: `Unlinked ${a.name} and ${b.name}` };
    }
    if (!input.kind) throw new OpError("kind is required");
    const row = normalizeRelationship({
      personId: a.id,
      relatedPersonId: b.id,
      kind: input.kind,
      label: input.label?.trim() || null,
      inverseLabel: input.inverseLabel?.trim() || null,
    });
    const r = existing ? await model.update({ id: existing.id, ...row }) : await model.create(row);
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const word = input.label?.trim() || RELATION_LABELS[input.kind];
    return { action: existing ? ("updated" as const) : ("created" as const), summary: `${a.name} is ${b.name}'s ${word}` };
  },
});

export const contactsOps = [listContacts, saveContact, listBusinesses, saveBusiness, listRelationships, saveRelationship];
