import { describe, expect, it } from "vitest";
import {
  mergeCandidates,
  mergeConfirmBody,
  mergeExplainer,
  mergeRewriteLines,
  mergeSummary,
  parseMergeRewrites,
} from "./people-merge";

const ann = { id: "a", name: "Ann" };
const annLogin = { id: "a", name: "Ann", cognitoUsername: "ann-sub" };
const bea = { id: "b", name: "Bea" };

describe("people merge helpers", () => {
  it("leaves the source out of the candidates", () => {
    expect(mergeCandidates([ann, bea], "a")).toEqual([bea]);
  });

  it("warns about a linked login only when there is one", () => {
    expect(mergeExplainer(ann)).not.toMatch(/login/);
    expect(mergeExplainer(annLogin)).toMatch(/has a login/);
    expect(mergeConfirmBody(ann, bea)).toMatch(/Ann's row will be deleted/);
  });

  it("parses rewrites from a JSON string or an object", () => {
    expect(parseMergeRewrites('{"homeTask.assignedPersonIds":2}')).toEqual({ "homeTask.assignedPersonIds": 2 });
    expect(parseMergeRewrites({ "homeReminder.personId": 1, junk: "x", zero: 0 })).toEqual({ "homeReminder.personId": 1 });
    expect(parseMergeRewrites("not json")).toEqual({});
    expect(parseMergeRewrites(null)).toEqual({});
  });

  it("labels counts, largest first, with a fallback for unknown models", () => {
    expect(
      mergeRewriteLines({ "homeTask.assignedPersonIds": 2, "homePhotoFace.personId": 7, "homeGiftIdea.personId": 1 }),
    ).toEqual(["Photo tags: 7", "Tasks: 2", "Gift idea: 1"]);
  });

  it("summarises, including an empty merge", () => {
    expect(mergeSummary(ann, bea, { "homeReminder.personId": 1 })).toBe("Ann was merged into Bea.\n\nReminders: 1");
    expect(mergeSummary(ann, bea, {})).toBe("Ann was merged into Bea. Nothing else referenced Ann.");
  });
});
