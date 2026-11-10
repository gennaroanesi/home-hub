// Contact book: people who aren't in the household (friends, family,
// people tagged in photos) and businesses / service people. Household
// members are managed on /admin/people and aren't edited here; see
// lib/people.ts and lib/businesses.ts.

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import { BUSINESS_CATEGORIES, businessMatches, businessRow, healthProviderRow } from "../businesses";
import { RELATIONSHIPS, daysToBirthday, inHousehold } from "../people";
import { todayIso } from "../finance/dates";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ContactOut = z.object({
  id: z.string(),
  name: z.string(),
  relationship: z.string().nullable(),
  birthday: z.string().nullable().describe("YYYY-MM-DD; year 1900 = unknown"),
  daysToBirthday: z.number().nullable(),
  phoneNumber: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
});

function contactOut(p: any, today: string): z.infer<typeof ContactOut> {
  return {
    id: p.id,
    name: p.name,
    relationship: p.relationship ?? null,
    birthday: p.birthday ?? null,
    daysToBirthday: daysToBirthday(p.birthday, today),
    phoneNumber: p.phoneNumber ?? null,
    email: p.email ?? null,
    notes: p.notes ?? null,
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

export const listContacts = defineOp({
  name: "list_contacts",
  domain: "contacts",
  access: "read",
  description:
    "The contact book's people: friends, family and others who aren't in the household, with relationship, birthday, phone, email and notes. Answers 'when is Marco's birthday?', 'whose birthdays are coming up?', 'what's Ana's number?'. Household members aren't included.",
  input: z.object({
    query: z.string().optional().describe("Words that must all appear in the name, email, phone or notes."),
    relationship: z.enum(RELATIONSHIPS).optional(),
    upcomingBirthdaysDays: z.number().int().min(0).max(366).optional().describe("Only people whose birthday is within this many days, soonest first."),
  }),
  output: z.object({ contacts: z.array(ContactOut) }),
  async run(ctx, input) {
    const today = todayIso();
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    let rows = (await allPeople(ctx))
      .filter((p) => !inHousehold(p) && p.active !== false)
      .filter((p) => !input.relationship || p.relationship === input.relationship)
      .filter((p) => words.every((w) => [p.name, p.email, p.phoneNumber, p.notes].filter(Boolean).join(" ").toLowerCase().includes(w)))
      .map((p) => contactOut(p, today));
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
    "Add a person to the contact book or change one. Without contactId it creates one (name required) and refuses a name that already exists. With contactId it updates only what's given; null clears a field. Household members can't be changed here.",
  input: z.object({
    contactId: z.string().optional(),
    name: z.string().optional(),
    relationship: z.enum(RELATIONSHIPS).nullable().optional(),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("YYYY-MM-DD; use 1900 for an unknown year."),
    phoneNumber: z.string().nullable().optional().describe("E.164, e.g. +15125551234"),
    email: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), contact: ContactOut }),
  async run(ctx, input) {
    const today = todayIso();
    const fields = Object.fromEntries(
      (["name", "relationship", "birthday", "phoneNumber", "email", "notes"] as const).filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === "string" ? (input[k] as string).trim() || null : input[k]]),
    );
    if (input.contactId) {
      const { data: p } = await ctx.client.models.homePerson.get({ id: input.contactId });
      if (!p) throw new OpError(`No contact with id ${input.contactId}`);
      if (inHousehold(p)) throw new OpError(`${p.name} is a household member; change them on the Household page`);
      if ("name" in fields && !fields.name) throw new OpError("name can't be empty");
      const r = await ctx.client.models.homePerson.update({ id: p.id, ...fields });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "updated" as const, contact: contactOut(r.data, today) };
    }
    const name = (input.name ?? "").trim();
    if (!name) throw new OpError("name is required to add a contact");
    const dup = (await allPeople(ctx)).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new OpError(`${dup.name} is already in the app; pass contactId to change them`, { contactId: dup.id });
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

export const contactsOps = [listContacts, saveContact, listBusinesses, saveBusiness];
