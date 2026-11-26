import { describe, expect, it } from "vitest";
import { invoiceOwnedBy, invoiceOwnerError, invoiceOwnerLabel, invoiceVisibleTo, personBySenderEmail } from "./invoice-owner";

const people = [
  { id: "g", name: "Gennaro", email: "G@example.com" },
  { id: "c", name: "Cristine", email: "cris@example.com" },
];

describe("invoice owners and privacy", () => {
  const house = { ownerPersonIds: [] };
  const mine = { ownerPersonIds: ["g"] };
  const secret = { ownerPersonIds: ["g"], private: true };

  it("shows a private invoice only to its owners, and to nobody without a viewer", () => {
    expect(invoiceVisibleTo(house, null)).toBe(true);
    expect(invoiceVisibleTo(mine, "c")).toBe(true);
    expect(invoiceVisibleTo(secret, "g")).toBe(true);
    expect(invoiceVisibleTo(secret, "c")).toBe(false);
    expect(invoiceVisibleTo(secret, null)).toBe(false);
  });

  it("filters to a person's plus the household's", () => {
    expect(invoiceOwnedBy(house, "c")).toBe(true);
    expect(invoiceOwnedBy(mine, "c")).toBe(false);
    expect(invoiceOwnedBy(mine, "all")).toBe(true);
  });

  it("labels and validates", () => {
    expect(invoiceOwnerLabel(house, people)).toBe("Household");
    expect(invoiceOwnerLabel({ ownerPersonIds: ["g", "c"] }, people)).toBe("Gennaro and Cristine");
    expect(invoiceOwnerError([], true)).toMatch(/needs an owner/);
    expect(invoiceOwnerError(["g"], true)).toBeNull();
  });

  it("finds the forwarder by email, whatever the display name or case", () => {
    expect(personBySenderEmail('"Gennaro A." <g@EXAMPLE.com>', people)?.id).toBe("g");
    expect(personBySenderEmail("cris@example.com", people)?.id).toBe("c");
    expect(personBySenderEmail("someone@else.com", people)).toBeNull();
  });
});
