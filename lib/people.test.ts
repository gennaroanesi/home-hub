import { describe, expect, it } from "vitest";
import {
  birthdayLabel,
  daysToBirthday,
  inHousehold,
  circleLabel,
  pickerSections,
  contactMatches,
  contactSections,
  editableGroups,
  invitableContacts,
  memberLine,
  personGroups,
  sameGroups,
} from "./people";

describe("people helpers", () => {
  it("labels birthdays with the age when the year is known", () => {
    expect(birthdayLabel("1990-03-04", "2026-11-10")).toBe("Mar 4 · turns 36");
    expect(birthdayLabel("1900-03-04", "2026-11-10")).toBe("Mar 4");
    expect(birthdayLabel(null, "2026-11-10")).toBeNull();
  });

  it("counts days to the next birthday, wrapping the year", () => {
    expect(daysToBirthday("1990-11-10", "2026-11-10")).toBe(0);
    expect(daysToBirthday("1990-11-12", "2026-11-10")).toBe(2);
    expect(daysToBirthday("1990-11-09", "2026-11-10")).toBe(364);
    expect(daysToBirthday(undefined, "2026-11-10")).toBeNull();
  });

  it("household is the home-users group, active or not", () => {
    expect(inHousehold({ groups: ["home-users", "admins"] })).toBe(true);
    expect(inHousehold({ groups: [] })).toBe(false);
    expect(inHousehold({})).toBe(false);
  });

  it("circle labels ignore unknown values", () => {
    expect(circleLabel("FAMILY")).toBe("Family");
    expect(circleLabel("ENEMY")).toBeNull();
  });

  it("picker sections: household, then circles, A–Z, searchable", () => {
    const people = [
      { id: "z", name: "Zoe", circle: "FRIEND" },
      { id: "c", name: "Cristine", groups: ["home-users"], circle: "FAMILY" },
      { id: "j", name: "José", circle: "FAMILY" },
      { id: "a", name: "Ana", circle: "FAMILY" },
      { id: "g", name: "Gennaro", groups: ["home-users"] },
      { id: "m", name: "Mike", circle: "WORK" },
      { id: "x", name: "Xavier" },
      { id: "b", name: "Bea", circle: "FRIEND" },
    ];
    expect(pickerSections(people).map((s) => [s.label, s.people.map((p) => p.name)])).toEqual([
      ["Household", ["Cristine", "Gennaro"]],
      ["Family", ["Ana", "José"]],
      ["Friends", ["Bea", "Zoe"]],
      ["Work", ["Mike"]],
      ["Other", ["Xavier"]],
    ]);
    expect(pickerSections(people, " jose ").map((s) => [s.key, s.people.map((p) => p.id)])).toEqual([["FAMILY", ["j"]]]);
    expect(pickerSections(people, "nobody")).toEqual([]);
  });
  it("contact sections: circles then Unsorted, household left out, search spans email / phone / notes", () => {
    const people = [
      { id: "c", name: "Cristine", groups: ["home-users"], circle: "FAMILY" },
      { id: "j", name: "José", circle: "FAMILY", notes: "plays tennis" },
      { id: "a", name: "Ana", circle: "FAMILY", email: "ana@example.com" },
      { id: "m", name: "Mike", circle: "WORK", phoneNumber: "+15125550000" },
      { id: "o", name: "Olga", circle: "OTHER" },
      { id: "x", name: "Xavier" },
      { id: "q", name: "Quinn", circle: "ENEMY" },
    ];
    expect(contactSections(people).map((s) => [s.key, s.people.map((p) => p.id)])).toEqual([
      ["FAMILY", ["a", "j"]],
      ["WORK", ["m"]],
      ["OTHER", ["o"]],
      ["NONE", ["q", "x"]],
    ]);
    expect(contactSections(people, "TENNIS").map((s) => s.people.map((p) => p.id))).toEqual([["j"]]);
    expect(contactSections(people, "555").map((s) => s.key)).toEqual(["WORK"]);
    expect(contactSections(people, "cristine")).toEqual([]);
    expect(contactMatches({ id: "j", name: "José Silva" }, "jose silva")).toBe(true);
    expect(contactMatches({ id: "j", name: "José Silva" }, "jose costa")).toBe(false);
    expect(contactMatches({ id: "j", name: "José" }, "  ")).toBe(true);
  });

  it("household helpers: groups, editable groups, member line, invitable", () => {
    expect(personGroups({ groups: ["home-users", null, "admins"] })).toEqual(["home-users", "admins"]);
    expect(personGroups({})).toEqual([]);
    expect(editableGroups({ cognitoUsername: "abc" })).toEqual(["home-users", "admins"]);
    expect(editableGroups({ cognitoUsername: null })).toEqual(["home-users"]);
    expect(sameGroups(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameGroups(["a"], ["a", "b"])).toBe(false);
    expect(memberLine({ email: "g@x.com", defaultTimezone: "America/Chicago", notifyWhatsApp: false, notifyPush: true })).toBe(
      "g@x.com · America/Chicago · WA off",
    );
    expect(memberLine({ notifyPush: false })).toBe("Push off");
    const people = [
      { id: "m", groups: ["home-users"], cognitoUsername: "m" },
      { id: "k", groups: ["home-users"], cognitoUsername: null },
      { id: "g", groups: [], cognitoUsername: "g" },
      { id: "c", groups: [], cognitoUsername: null },
    ];
    expect(invitableContacts(people).map((p) => p.id)).toEqual(["c"]);
  });
});
