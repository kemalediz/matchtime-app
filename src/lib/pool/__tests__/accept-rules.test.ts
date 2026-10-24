import { describe, expect, it } from "vitest";
import { offerPageState, organiserRecordOf } from "../accept-rules";

const base = { outcome: null, refusal: null, guestResult: null, attendanceStatus: null, matchLive: true };

describe("offerPageState", () => {
  const table: Array<[string, Partial<Parameters<typeof offerPageState>[0]>, string]> = [
    ["an open offer", {}, "open"],
    ["the game is off", { refusal: "match-off" }, "off"],
    ["the round closed before the sweep marked it", { refusal: "gone" }, "gone"],
    ["past its time", { refusal: "expired" }, "expired"],
    ["he stopped meanwhile", { refusal: "profile-off" }, "expired"],
    ["never sent", { refusal: "not-sent" }, "invalid"],
    ["the pool was switched off", { refusal: "pool-closed" }, "expired"],
    ["accepted, confirmed", { outcome: "accepted", attendanceStatus: "CONFIRMED" }, "in"],
    ["accepted, on the bench", { outcome: "accepted", attendanceStatus: "BENCH" }, "bench"],
    ["accepted, gave it back in time", { outcome: "accepted", guestResult: "withdrawn" }, "withdrawn"],
    ["accepted, gave it back late", { outcome: "accepted", guestResult: "late-cancel" }, "withdrawn"],
    ["accepted, then the game was called off", { outcome: "accepted", attendanceStatus: "CONFIRMED", matchLive: false }, "off"],
    ["accepted, then dropped by the organisers", { outcome: "accepted", attendanceStatus: "DROPPED" }, "withdrawn"],
    ["declined", { outcome: "declined" }, "declined"],
    ["lost the race", { outcome: "filled" }, "gone"],
    ["the round closed", { outcome: "expired" }, "expired"],
    ["ignored", { outcome: "ignored" }, "expired"],
    ["cancelled", { outcome: "cancelled" }, "expired"],
  ];
  for (const [name, over, want] of table) it(name, () => expect(offerPageState({ ...base, ...over })).toBe(want));
});

describe("organiserRecordOf", () => {
  it("own-club and guest games played, less no-shows; misses are no-shows and late cancels", () => {
    expect(organiserRecordOf({ confirmedCompleted: 0, noShows: 0, lateCancels: 0 })).toEqual({ played: 0, missed: 0 });
    expect(organiserRecordOf({ confirmedCompleted: 6, noShows: 0, lateCancels: 0 })).toEqual({ played: 6, missed: 0 });
    expect(organiserRecordOf({ confirmedCompleted: 5, noShows: 1, lateCancels: 1 })).toEqual({ played: 4, missed: 2 });
  });
});
