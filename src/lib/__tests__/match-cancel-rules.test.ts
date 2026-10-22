/**
 * Which match an organiser's "cancel the session" or "it's back on" in HQ
 * is about (2026-10-22): the next one still to come, or the one on the day
 * named. Pure; no database.
 */
import { describe, expect, it } from "vitest";
import { pickHqMatch } from "../match-cancel-rules";

// Thursday 22 Oct 2026, 15:00 London (14:00 UTC).
const NOW = new Date("2026-10-22T14:00:00Z");
const m = (id: string, iso: string, status = "UPCOMING") => ({ id, date: new Date(iso), status });
const FRI = m("fri", "2026-10-23T19:30:00Z");
const NEXT_FRI = m("fri2", "2026-10-30T20:30:00Z");
const PAST = m("past", "2026-10-16T19:30:00Z", "COMPLETED");

describe("pickHqMatch: cancel", () => {
  it("no day named: the next match still to come", () => {
    expect(pickHqMatch([NEXT_FRI, FRI, PAST], NOW, "cancel", "")?.id).toBe("fri");
  });
  it("never a completed, cancelled or already kicked-off match", () => {
    const today = m("today", "2026-10-22T13:00:00Z");
    expect(pickHqMatch([PAST, today, { ...FRI, status: "CANCELLED" }, NEXT_FRI], NOW, "cancel", "")?.id).toBe("fri2");
  });
  it("teams made or published still count as to come", () => {
    expect(pickHqMatch([{ ...FRI, status: "TEAMS_PUBLISHED" }], NOW, "cancel", null)?.id).toBe("fri");
  });
  it("a named weekday: that day's match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "Friday")?.id).toBe("fri");
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "cuma")?.id).toBe("fri");
  });
  it("next week: the first match from next Monday", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "next week")?.id).toBe("fri2");
  });
  it("tomorrow", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "tomorrow")?.id).toBe("fri");
  });
  it("a day with no match: none, never a different match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "Tuesday")).toBeNull();
  });
  it("words that name no day: the next match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "this week")?.id).toBe("fri");
  });
  it("nothing to come: none", () => {
    expect(pickHqMatch([PAST], NOW, "cancel", "")).toBeNull();
  });
});

describe("pickHqMatch: restore", () => {
  it("the next cancelled match still to come", () => {
    const c = { ...FRI, status: "CANCELLED" };
    expect(pickHqMatch([c, NEXT_FRI], NOW, "restore", "")?.id).toBe("fri");
  });
  it("a cancelled match already past is never put back on", () => {
    const c = m("old", "2026-10-22T10:00:00Z", "CANCELLED");
    expect(pickHqMatch([c, FRI], NOW, "restore", "")).toBeNull();
  });
  it("a match that is not cancelled is not restored", () => {
    expect(pickHqMatch([FRI], NOW, "restore", "Friday")).toBeNull();
  });
});
