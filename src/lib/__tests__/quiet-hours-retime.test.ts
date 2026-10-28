/**
 * Saving new quiet hours re-times the club's messages they were holding
 * (Kemal, 2026-10-28). A queued BotJob keeps the `sendAfter` stamped when
 * it was queued, so without this a club that shortens its quiet hours still
 * waits for the old end.
 *
 * A job is a quiet hours hold when its `sendAfter` is EXACTLY the end of
 * the club's old quiet hours for the moment it was created (which also
 * means it was created inside them). Jobs queued before this fix shipped
 * carry no other mark, so this is the test that reaches them.
 */
import { describe, expect, it } from "vitest";
import { isQuietHoursHold, retimeQuietHoursHolds } from "../quiet-hours-retime";
import type { QuietHours } from "../message-hours";

const at = (iso: string) => new Date(iso);
const DEFAULT: QuietHours = { enabled: true, from: "23:00", to: "09:00" };
const EARLIER: QuietHours = { enabled: true, from: "23:00", to: "07:00" };
const LATER: QuietHours = { enabled: true, from: "23:00", to: "10:30" };
const OFF: QuietHours = { enabled: false, from: "23:00", to: "09:00" };

// 2026-12-02 is GMT, so London wall clock = UTC.
const job = (id: string, createdAt: string, sendAfter: string | null) => ({
  id,
  createdAt: at(createdAt),
  sendAfter: sendAfter ? at(sendAfter) : null,
});

describe("isQuietHoursHold", () => {
  it("a job created inside the quiet hours and held to exactly their end is a hold", () => {
    expect(isQuietHoursHold(job("a", "2026-12-02T01:15:00.123Z", "2026-12-02T09:00:00.000Z"), DEFAULT)).toBe(true);
    // created before midnight: held to the NEXT morning
    expect(isQuietHoursHold(job("b", "2026-12-01T23:40:00Z", "2026-12-02T09:00:00Z"), DEFAULT)).toBe(true);
  });

  it("a job created in the daytime is never a hold, even when its time is the quiet end (a deliberate schedule)", () => {
    expect(isQuietHoursHold(job("r", "2026-12-01T15:00:00Z", "2026-12-02T09:00:00Z"), DEFAULT)).toBe(false);
  });

  it("a job held to any other time is not a hold (a redraw delay, a reminder, a pool time)", () => {
    expect(isQuietHoursHold(job("x", "2026-12-02T01:15:00Z", "2026-12-02T01:17:00Z"), DEFAULT)).toBe(false);
    expect(isQuietHoursHold(job("y", "2026-12-02T01:15:00Z", "2026-12-02T09:00:01Z"), DEFAULT)).toBe(false);
    // the right time, the wrong day
    expect(isQuietHoursHold(job("z", "2026-12-02T01:15:00Z", "2026-12-03T09:00:00Z"), DEFAULT)).toBe(false);
  });

  it("no sendAfter, or old quiet hours that were off: not a hold", () => {
    expect(isQuietHoursHold(job("n", "2026-12-02T01:15:00Z", null), DEFAULT)).toBe(false);
    expect(isQuietHoursHold(job("o", "2026-12-02T01:15:00Z", "2026-12-02T09:00:00Z"), OFF)).toBe(false);
  });

  it("the two jobs Kemal is testing on (28 Oct, GMT): created overnight, held to 09:00 UTC", () => {
    expect(isQuietHoursHold(job("cmvrpte0b000308k13s53f1s8", "2026-10-28T05:30:00Z", "2026-10-28T09:00:00Z"), DEFAULT)).toBe(true);
    expect(isQuietHoursHold(job("cmvrpneyu000108legvoe1ti4", "2026-10-27T23:05:00Z", "2026-10-28T09:00:00Z"), DEFAULT)).toBe(true);
  });
});

describe("retimeQuietHoursHolds", () => {
  const held = job("h", "2026-12-02T01:15:00Z", "2026-12-02T09:00:00Z");

  it("shorter hours release the hold sooner: held to the new end when now is still inside them", () => {
    expect(retimeQuietHoursHolds({ jobs: [held], oldQuiet: DEFAULT, newQuiet: EARLIER, now: at("2026-12-02T06:00:00Z") })).toEqual([
      { id: "h", sendAfter: at("2026-12-02T07:00:00Z") },
    ]);
  });

  it("shorter hours that have already ended: released now (sendAfter null)", () => {
    expect(retimeQuietHoursHolds({ jobs: [held], oldQuiet: DEFAULT, newQuiet: EARLIER, now: at("2026-12-02T08:00:00Z") })).toEqual([
      { id: "h", sendAfter: null },
    ]);
  });

  it("quiet hours switched off: released now", () => {
    expect(retimeQuietHoursHolds({ jobs: [held], oldQuiet: DEFAULT, newQuiet: OFF, now: at("2026-12-02T06:00:00Z") })).toEqual([
      { id: "h", sendAfter: null },
    ]);
  });

  it("longer hours hold it later", () => {
    expect(retimeQuietHoursHolds({ jobs: [held], oldQuiet: DEFAULT, newQuiet: LATER, now: at("2026-12-02T06:00:00Z") })).toEqual([
      { id: "h", sendAfter: at("2026-12-02T10:30:00Z") },
    ]);
  });

  it("the same hours change nothing", () => {
    expect(retimeQuietHoursHolds({ jobs: [held], oldQuiet: DEFAULT, newQuiet: DEFAULT, now: at("2026-12-02T06:00:00Z") })).toEqual([]);
  });

  it("jobs held for other reasons, or already due, are left alone", () => {
    const jobs = [
      job("reminder", "2026-12-01T15:00:00Z", "2026-12-02T09:00:00Z"),
      job("redraw", "2026-12-02T05:58:00Z", "2026-12-02T06:00:30Z"),
      job("due", "2026-12-01T23:30:00Z", "2026-12-02T05:00:00Z"),
      job("now", "2026-12-02T05:00:00Z", null),
    ];
    expect(retimeQuietHoursHolds({ jobs, oldQuiet: DEFAULT, newQuiet: EARLIER, now: at("2026-12-02T06:00:00Z") })).toEqual([]);
  });

  it("a hold made under hours that were OFF cannot exist, so nothing is re-timed when switching them on", () => {
    const j = job("p", "2026-12-02T01:15:00Z", "2026-12-02T09:00:00Z");
    expect(retimeQuietHoursHolds({ jobs: [j], oldQuiet: OFF, newQuiet: EARLIER, now: at("2026-12-02T06:00:00Z") })).toEqual([]);
  });
});
