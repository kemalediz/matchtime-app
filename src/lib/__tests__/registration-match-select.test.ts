/**
 * Unit tests for the DETERMINISTIC ROLLOVER GUARD — the pure date-
 * selection logic that decides WHICH match an attendance write lands on.
 *
 * Bug (2026-06-18, Sutton Lads): tonight's match was FULL → casual "In"s
 * were attributed to next week's empty match. The active registration
 * match must be the SOONEST upcoming match in the current cycle,
 * REGARDLESS of fullness — fullness routes to bench within THAT match, it
 * must never advance the target to a later match. Next week's match must
 * not become the target until this week's is COMPLETED or past kickoff.
 *
 * Pure logic — no DB. The route's findRegistrationMatch loads candidate
 * matches and delegates the decision here so it's unit-testable and so
 * the LLM-context / reply queries can share the exact same selector.
 */
import { describe, it, expect } from "vitest";
import {
  selectRegistrationMatch,
  type SelectableMatch,
} from "@/lib/registration-match-select";

const at = (iso: string): Date => new Date(iso);

describe("selectRegistrationMatch", () => {
  it("returns the soonest upcoming match (single match)", () => {
    const now = at("2026-06-18T17:00:00Z");
    const matches: SelectableMatch[] = [
      { id: "tonight", date: at("2026-06-18T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)?.id).toBe("tonight");
  });

  it("THE BUG: this-week match (today, still upcoming) wins over next week's empty match", () => {
    // Even though tonight's squad may be FULL, the selector must still
    // return tonight's match — fullness is decided downstream (bench),
    // never here. Returning next week would silently register casual
    // "In"s for the wrong match.
    const now = at("2026-06-18T17:00:00Z"); // past tonight's 5h-before deadline
    const matches: SelectableMatch[] = [
      { id: "next-week", date: at("2026-06-25T19:00:00Z"), status: "UPCOMING" },
      { id: "tonight", date: at("2026-06-18T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)?.id).toBe("tonight");
  });

  it("does NOT advance to next week even when tonight is past its attendanceDeadline", () => {
    // attendanceDeadline is intentionally NOT a factor — registration is
    // open right up to kickoff/completion. (registerAttendance enforces
    // the in-flight guard separately.)
    const now = at("2026-06-18T17:00:00Z");
    const matches: SelectableMatch[] = [
      {
        id: "tonight",
        date: at("2026-06-18T19:00:00Z"),
        status: "UPCOMING",
        attendanceDeadline: at("2026-06-18T14:00:00Z"), // already passed
      },
      { id: "next-week", date: at("2026-06-25T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)?.id).toBe("tonight");
  });

  it("blocks (returns null) while a PREVIOUS-DAY match is still in flight", () => {
    // A non-completed match dated before today's UTC midnight means the
    // cron hasn't completed last cycle yet — never roll forward.
    const now = at("2026-06-18T10:00:00Z");
    const matches: SelectableMatch[] = [
      { id: "yesterday", date: at("2026-06-17T19:00:00Z"), status: "UPCOMING" },
      { id: "next-week", date: at("2026-06-25T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)).toBeNull();
  });

  it("rolls to next week ONLY once this week's match is COMPLETED", () => {
    const now = at("2026-06-19T10:00:00Z"); // day after tonight
    const matches: SelectableMatch[] = [
      { id: "tonight", date: at("2026-06-18T19:00:00Z"), status: "COMPLETED" },
      { id: "next-week", date: at("2026-06-25T19:00:00Z"), status: "UPCOMING" },
    ];
    // tonight is COMPLETED (not in-flight) and dated before today →
    // ignored; next week is the soonest non-completed upcoming match.
    expect(selectRegistrationMatch(matches, now)?.id).toBe("next-week");
  });

  it("ignores COMPLETED matches entirely", () => {
    const now = at("2026-06-18T17:00:00Z");
    const matches: SelectableMatch[] = [
      { id: "done", date: at("2026-06-18T12:00:00Z"), status: "COMPLETED" },
      { id: "tonight", date: at("2026-06-18T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)?.id).toBe("tonight");
  });

  it("returns null when there is no upcoming match", () => {
    const now = at("2026-06-18T17:00:00Z");
    expect(selectRegistrationMatch([], now)).toBeNull();
  });

  it("treats TEAMS_GENERATED / TEAMS_PUBLISHED as still upcoming", () => {
    const now = at("2026-06-18T17:00:00Z");
    const matches: SelectableMatch[] = [
      { id: "tonight", date: at("2026-06-18T19:00:00Z"), status: "TEAMS_PUBLISHED" },
      { id: "next-week", date: at("2026-06-25T19:00:00Z"), status: "UPCOMING" },
    ];
    expect(selectRegistrationMatch(matches, now)?.id).toBe("tonight");
  });
});
