import { describe, expect, it } from "vitest";
import { birthdayLabel, daysToBirthday, inHousehold, circleLabel, pickerSections } from "./people";

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
});
