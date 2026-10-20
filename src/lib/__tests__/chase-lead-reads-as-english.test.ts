/**
 * The lead line of a scheduled chase must read as English.
 *
 * ── the incident (dry run, 2026-09-05, live model, reproduced twice) ──
 *
 *     ☀️ Morning all — we still need 8 players for on Tue 8 Sept
 *     21:30's 7-a-side at Goals North Cheam, kickoff 21:30.
 *
 *     We're 8 short for on Tue 8 Sept 21:30's 7-a-side …
 *
 *     Squad locked in — see you all on Tue 8 Sept 21:30 at 21:30 …
 *
 * "for on Tue 8 Sept 21:30's" is not English, and the kickoff time is
 * printed twice.
 *
 * ── the cause, which is NOT the model ────────────────────────────────
 *
 * Both artefacts are produced DETERMINISTICALLY by `enforceProximity`,
 * with no model involvement at all. Feed it the perfectly good sentence
 * the model actually wrote — "we still need 8 players for tonight's
 * 7-a-side …" — and it returns the broken one, byte for byte.
 *
 * Two separate faults compound:
 *
 *   1. `kickoffLocal` was built with a single `Intl.DateTimeFormat`
 *      carrying weekday+day+month AND hour+minute, then `.replace(/,/g,
 *      "")`. en-GB renders that as "Tue 8 Sept, 21:30", so stripping the
 *      comma leaves "Tue 8 Sept 21:30" — and the ` at ` the code then
 *      tried to `.split()` on (per its own comment, `Format: "Tue 28 Apr
 *      at 21:30"`) was never there. `split(" at ")[0]` therefore returned
 *      the WHOLE string, so the "day part" carried the kickoff time into
 *      the roster header and into `friendlyDay`.
 *
 *   2. `enforceProximity` substituted `friendlyDay` ("on Tue 8 Sept")
 *      for the bare token "tonight" with no regard for the grammar
 *      around it. "for tonight's 7-a-side" → "for on … 's 7-a-side".
 *
 * Fault 1 alone gives the duplicated time; fault 2 alone gives "for on".
 * Both are fixed here, and both halves are asserted separately so a
 * future regression names which one came back.
 *
 * These are deterministic tests over pure functions — no model, no DB.
 * The live counterpart (all five chase kinds, real model) is
 * `scripts/dryrun-pipeline.ts --chases`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { enforceProximity } from "@/lib/message-analyzer";
import { chaseLeadUserTurn } from "@/lib/chase-lead";

/** Tue 8 Sept 2026, 21:30 London (BST → 20:30Z). */
const KICKOFF = new Date("2026-09-08T20:30:00.000Z");
/** Sun 6 Sept 2026, 12:00 London — two days out, so proximity=this-week. */
const TWO_DAYS_BEFORE = new Date("2026-09-06T11:00:00.000Z");

function at(nowIso: string, fn: () => string): string {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

describe("the kickoff handed to the model is written once, day and time apart", () => {
  // Since 2026-10-20 the model is handed the facts (`chaseLeadUserTurn`)
  // instead of the old clock block; the shape that taught it to glue the
  // date to the time ("Tue 8 Sept 21:30") must not come back.
  const turn = (nowIso: string) =>
    chaseLeadUserTurn({
      kind: "daily-in-list",
      lang: "en",
      activityName: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      kickoff: KICKOFF,
      now: new Date(nowIso),
      confirmed: 6,
      maxPlayers: 14,
      bench: 0,
      atRisk: false,
    });

  it("states the kickoff time once, separated from the date by ' at '", () => {
    const line = turn(TWO_DAYS_BEFORE.toISOString()).split("\n").find((l) => l.startsWith("Kickoff:"));
    expect(line).toBe("Kickoff: Tuesday 8 September at 21:30 (in 2 days)");
    expect(line!.match(/\d{1,2}:\d{2}/g)).toHaveLength(1);
  });

  it("says today and tomorrow by calendar day", () => {
    expect(turn("2026-09-08T06:00:00.000Z")).toContain("(today)");
    expect(turn("2026-09-07T18:00:00.000Z")).toContain("(tomorrow)");
  });
});

describe("enforceProximity rewrites 'tonight' into English", () => {
  const fix = (s: string) =>
    at(TWO_DAYS_BEFORE.toISOString(), () => enforceProximity(s, KICKOFF));

  it("does not produce 'for on'", () => {
    const out = fix(
      "☀️ Morning all — we still need 8 players for tonight's 7-a-side at Goals North Cheam, kickoff 21:30.",
    );
    expect(out).not.toContain("for on ");
    expect(out).toBe(
      "☀️ Morning all — we still need 8 players for Tue 8 Sept's 7-a-side at Goals North Cheam, kickoff 21:30.",
    );
  });

  it("does not produce 'for on' in the pre-kickoff chase either", () => {
    const out = fix("We're 8 short for tonight's 7-a-side at Goals North Cheam — kickoff 21:30.");
    expect(out).not.toContain("for on ");
    expect(out).toBe(
      "We're 8 short for Tue 8 Sept's 7-a-side at Goals North Cheam — kickoff 21:30.",
    );
  });

  it("does not print the kickoff time twice", () => {
    const out = fix("Squad locked in — see you all tonight at 21:30, Goals North Cheam!");
    expect(out).toBe("Squad locked in — see you all on Tue 8 Sept at 21:30, Goals North Cheam!");
    expect(out.match(/21:30/g)).toHaveLength(1);
  });

  it("keeps the bare 'on <day>' form when nothing precedes it", () => {
    expect(fix("Kickoff is tonight.")).toBe("Kickoff is on Tue 8 Sept.");
  });

  it("never doubles a preposition, whichever one the model used", () => {
    for (const prep of ["on", "for", "at", "by", "before", "after", "until", "from"]) {
      const out = fix(`We play ${prep} tonight.`);
      expect(out, `"${prep} tonight" must not become "${prep} on …"`).toBe(
        `We play ${prep} Tue 8 Sept.`,
      );
    }
  });

  it("handles a curly apostrophe the same as a straight one", () => {
    expect(fix("short for tonight’s game")).toBe("short for Tue 8 Sept’s game");
  });

  it("applies the same grammar to 'tomorrow' and 'this evening'", () => {
    expect(fix("nothing booked for tomorrow's game")).toBe(
      "nothing booked for Tue 8 Sept's game",
    );
    expect(fix("we play this evening")).toBe("we play on Tue 8 Sept");
  });

  it("leaves the roster header alone — that path already worked", () => {
    expect(fix("*Playing tonight:*\n1. Kemal")).toBe("*Playing Tue 8 Sept:*\n1. Kemal");
  });

  it("touches nothing when the match really is tonight", () => {
    const text = "☀️ we still need 8 players for tonight's 7-a-side, kickoff 21:30.";
    expect(at("2026-09-08T18:00:00.000Z", () => enforceProximity(text, KICKOFF))).toBe(text);
  });

  it("still corrects a UTC kickoff time to London wall-clock", () => {
    // Pre-existing behaviour (the "off-by-1h" net) that this change
    // must not disturb: 20:30Z is 21:30 in London.
    expect(fix("kickoff at 20:30 sharp")).toBe("kickoff at 21:30 sharp");
  });
});

describe("no chase lead may contain a broken preposition pair", () => {
  // A blunt guard over the shapes the incident produced, applied to the
  // whole composed message rather than one sentence.
  const BROKEN = /\b(?:for|at|on|by|from|until|before|after)\s+on\s/i;

  it("catches the shape the incident produced", () => {
    expect(BROKEN.test("we still need 8 players for on Tue 8 Sept's 7-a-side")).toBe(true);
  });

  it("passes on the fixed output", () => {
    const out = at(TWO_DAYS_BEFORE.toISOString(), () =>
      enforceProximity(
        "☀️ Morning all — we still need 8 players for tonight's 7-a-side, kickoff 21:30.",
        KICKOFF,
      ),
    );
    expect(BROKEN.test(out)).toBe(false);
  });
});
