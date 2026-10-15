/**
 * The "New players to review" notice is due once per player, not once per
 * day (2026-10-15): a club rehearsal posted it twelve mornings running
 * about the same two pasted-in players.
 */
import { describe, it, expect } from "vitest";
import {
  parseProvisionalReviewKey,
  provisionalReviewCutoff,
  provisionalReviewKey,
  splitProvisionalByCutoff,
} from "../provisional-review-rules";

const ORG = "org-1";
const T1 = new Date("2026-10-01T10:00:00.000Z");
const T2 = new Date("2026-10-03T18:30:00.000Z");
const T3 = new Date("2026-10-07T12:00:00.000Z");

const cutoff = (sent: string[], newest: Date, legacy: Array<[string, Date]> = []) =>
  provisionalReviewCutoff({ orgId: ORG, sentKeys: sent, legacySentAt: new Map(legacy), newestAddedAt: newest });

describe("provisional review keys", () => {
  it("a batch key carries the newest player's added time", () => {
    const key = provisionalReviewKey(ORG, "admin-group", T2);
    expect(key).toBe(`org-${ORG}:provisional-review:admin-group:p${T2.getTime()}`);
    expect(parseProvisionalReviewKey(ORG, key)).toBe(T2.getTime());
  });

  it("the old day key is recognised as legacy; other clubs' and other notices' keys are not ours", () => {
    expect(parseProvisionalReviewKey(ORG, `org-${ORG}:provisional-review:admin-1:2026-10-02`)).toBe("legacy");
    expect(parseProvisionalReviewKey(ORG, `org-other:provisional-review:admin-group:p1`)).toBeNull();
    expect(parseProvisionalReviewKey(ORG, `org-${ORG}:bot-intro`)).toBeNull();
  });
});

describe("provisionalReviewCutoff", () => {
  it("nothing sent: no cutoff, everyone is new", () => {
    expect(cutoff([], T1)).toBeNull();
  });

  it("the batch already told is the cutoff, the next day too", () => {
    const sent = [provisionalReviewKey(ORG, "admin-group", T2)];
    expect(cutoff(sent, T3)).toEqual(T2);
  });

  it("a notice still reaching some admins keeps the cutoff from before it", () => {
    const sent = [provisionalReviewKey(ORG, "admin-a", T1), provisionalReviewKey(ORG, "admin-a", T2)];
    expect(cutoff(sent, T2)).toEqual(T1);
  });

  it("the newest player reviewed away: an older batch is not told again", () => {
    // T1 and T2 named together under marker T2; T2 reviewed, newest is now T1.
    const sent = [provisionalReviewKey(ORG, "admin-group", T2)];
    const c = cutoff(sent, T1);
    expect(c).toEqual(T2);
    expect(splitProvisionalByCutoff([{ provisionallyAddedAt: T1 }], c).fresh).toEqual([]);
  });

  it("a day-keyed notice sent before the change counts from when it was sent", () => {
    const legacy = `org-${ORG}:provisional-review:admin-group:2026-10-04`;
    const sentAt = new Date("2026-10-04T08:00:05.000Z");
    expect(cutoff([legacy], T2, [[legacy, sentAt]])).toEqual(sentAt);
  });
});

describe("splitProvisionalByCutoff", () => {
  it("names only the players added after the cutoff", () => {
    const waiting = [
      { id: "c", provisionallyAddedAt: T3 },
      { id: "b", provisionallyAddedAt: T2 },
      { id: "a", provisionallyAddedAt: T1 },
    ];
    const { fresh, earlier } = splitProvisionalByCutoff(waiting, T2);
    expect(fresh.map((p) => p.id)).toEqual(["c"]);
    expect(earlier.map((p) => p.id)).toEqual(["b", "a"]);
  });
});
