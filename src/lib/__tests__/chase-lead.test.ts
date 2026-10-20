/**
 * THE SCHEDULED CHASE, REWRITTEN (2026-10-20): code writes the post, the
 * model writes one opening line.
 *
 * The old composer asked Sonnet for the whole post (a numbered roster
 * with drum rows, the bench block, the format-switch line copied
 * verbatim, a tentative line it had to guess) and the scheduler then cut
 * the roster back out when the group had just seen it. Now the roster is
 * `buildSquadRosterBlock`, the same block every other scheduled post
 * carries, the format-switch line is the server's own, and the model is
 * asked only for the lead. A lead that breaks a fact is replaced by the
 * fixed one, so a number in the post can only come from the database.
 */
import { describe, it, expect } from "vitest";
import {
  CHASE_LEAD_SYSTEM,
  acceptChaseLead,
  assembleChasePost,
  chaseFallbackLead,
  chaseLeadUserTurn,
  chaseSwitchLine,
  type ChaseFacts,
} from "@/lib/chase-lead";
import { buildSquadRosterBlock } from "@/lib/scheduler-copy";
import { t } from "@/lib/i18n/t";

/** Tue 8 Sept 2026, 21:30 London (20:30Z); "now" is Sat 5 Sept 17:00. */
const KICKOFF = new Date("2026-09-08T20:30:00.000Z");
const NOW = new Date("2026-09-05T16:00:00.000Z");

function facts(over: Partial<ChaseFacts> = {}): ChaseFacts {
  return {
    kind: "daily-in-list",
    lang: "en",
    activityName: "Tuesday 7-a-side",
    venue: "Sim Arena",
    kickoff: KICKOFF,
    now: NOW,
    confirmed: 6,
    maxPlayers: 14,
    bench: 1,
    atRisk: false,
    ...over,
  };
}

describe("the system prompt", () => {
  it("names no club, no player and no venue", () => {
    for (const word of ["Sutton", "Kemal", "Elvin", "Ibrahim", "Sim Arena", "21:30"]) {
      expect(CHASE_LEAD_SYSTEM).not.toContain(word);
    }
  });

  it("carries no em or en dash", () => {
    expect(CHASE_LEAD_SYSTEM).not.toMatch(/[—–]/);
  });

  it("asks for the opening line only, never the list", () => {
    expect(CHASE_LEAD_SYSTEM).toMatch(/opening line/i);
    expect(CHASE_LEAD_SYSTEM).toMatch(/never lists? players|name no players/i);
    expect(CHASE_LEAD_SYSTEM).not.toMatch(/roster block|🥁/);
  });

  it("keeps the standing rules: no send time, no greeting, the group calls a game off", () => {
    expect(CHASE_LEAD_SYSTEM).toMatch(/time the post is sent/i);
    expect(CHASE_LEAD_SYSTEM).toMatch(/no greeting/i);
    expect(CHASE_LEAD_SYSTEM).toMatch(/never "I will cancel"/);
  });

  it("is long enough for Haiku 5.5 to cache (512 tokens, about 2.6 characters each)", () => {
    expect(CHASE_LEAD_SYSTEM.length).toBeGreaterThan(512 * 2.6);
  });
});

describe("the user turn states the facts, and only the facts", () => {
  it("English: the counts, the kickoff, the post kind and the risk", () => {
    const u = chaseLeadUserTurn(facts());
    expect(u).toContain("Language: English");
    expect(u).toContain("Post: daily");
    expect(u).toContain("Match: Tuesday 7-a-side, at Sim Arena");
    expect(u).toContain("Kickoff: Tuesday 8 September at 21:30 (in 3 days)");
    expect(u).toContain("Squad: 6 of 14 confirmed, 8 places open, 1 on the bench");
    expect(u).toContain("At risk: no");
  });

  it("Turkish: the kickoff written the Turkish way", () => {
    const u = chaseLeadUserTurn(facts({ lang: "tr", activityName: "Salı Halısaha" }));
    expect(u).toContain("Language: Turkish");
    expect(u).toContain("Kickoff: 8 Eylül Salı 21:30 (in 3 days)");
  });

  it("today and tomorrow are said as such", () => {
    expect(chaseLeadUserTurn(facts({ now: new Date("2026-09-08T07:00:00.000Z") }))).toContain("(today)");
    expect(chaseLeadUserTurn(facts({ now: new Date("2026-09-07T16:00:00.000Z") }))).toContain("(tomorrow)");
  });

  it("each kind has its own name", () => {
    expect(chaseLeadUserTurn(facts({ kind: "match-day-morning" }))).toContain("Post: match-day");
    expect(chaseLeadUserTurn(facts({ kind: "chase-pre-kickoff" }))).toContain("Post: before-kickoff");
    expect(chaseLeadUserTurn(facts({ kind: "pre-kickoff-short" }))).toContain("Post: last-call");
  });

  it("at risk is a fact handed over, never a judgement left to the model", () => {
    expect(chaseLeadUserTurn(facts({ atRisk: true }))).toContain("At risk: yes");
  });

  it("names no player", () => {
    expect(chaseLeadUserTurn(facts())).not.toMatch(/Ali|Dan|Sam/);
  });
});

describe("the fallback lead is the fixed copy of each kind", () => {
  it("English, every kind", () => {
    const s = t("en");
    expect(chaseFallbackLead(facts())).toBe(s.daily_in_list_fallback_lead({ activityName: "Tuesday 7-a-side", need: 8 }));
    expect(chaseFallbackLead(facts({ kind: "match-day-morning" }))).toBe(
      s.match_day_chase_fallback({ need: 8, activityName: "Tuesday 7-a-side" }),
    );
    expect(chaseFallbackLead(facts({ kind: "chase-pre-kickoff" }))).toBe(
      s.chase_pre_kickoff_fallback({ need: 8, activityName: "Tuesday 7-a-side", timeLabel: "21:30" }),
    );
    expect(chaseFallbackLead(facts({ kind: "pre-kickoff-short" }))).toBe(
      s.pre_kickoff_short_fallback({ timeLabel: "21:30", venue: "Sim Arena", confirmed: 6, maxPlayers: 14, need: 8 }),
    );
  });

  it("Turkish", () => {
    expect(chaseFallbackLead(facts({ lang: "tr" }))).toBe(
      t("tr").daily_in_list_fallback_lead({ activityName: "Tuesday 7-a-side", need: 8 }),
    );
  });

  it("the kickoff time is London's, not the server's UTC", () => {
    expect(chaseFallbackLead(facts({ kind: "chase-pre-kickoff" }))).toContain("21:30");
    expect(chaseFallbackLead(facts({ kind: "chase-pre-kickoff" }))).not.toContain("20:30");
  });
});

describe("acceptChaseLead: a lead that breaks a fact is not posted", () => {
  it("keeps a good lead, trimmed", () => {
    expect(acceptChaseLead("  🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* if you can play ⚽ ", facts())).toBe(
      "🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* if you can play ⚽",
    );
  });

  it("allows the kickoff time and day, the counts and the days to go", () => {
    expect(acceptChaseLead("6 of 14 in, 8 to go for Tue 8 Sept at 21:30, 3 days out, 1 on the bench.", facts())).not.toBeNull();
  });

  it("rejects a number the facts do not hold", () => {
    expect(acceptChaseLead("We need *3 more* for Tuesday.", facts())).toBeNull();
    expect(acceptChaseLead("Kickoff 19:00, say IN.", facts())).toBeNull();
  });

  it("rejects a count that disagrees with the rows", () => {
    expect(acceptChaseLead("We're 8/14, say IN.", facts())).toBeNull();
  });

  it("rejects a lead that lists players", () => {
    expect(acceptChaseLead("Need 8 more.\n1. Ali\n2. Dan", facts())).toBeNull();
  });

  it("rejects an empty or overlong lead", () => {
    expect(acceptChaseLead("   ", facts())).toBeNull();
    expect(acceptChaseLead("Need 8 more. ".repeat(40), facts())).toBeNull();
  });

  it("takes out dashes and corrects 'tonight' for a match days away (English)", () => {
    expect(acceptChaseLead("Need 8 more for tonight — say IN", facts())).toBe("Need 8 more for Tue 8 Sept, say IN");
  });

  it("corrects a UTC kickoff time to London's", () => {
    expect(acceptChaseLead("Kickoff 20:30, need 8 more.", facts())).toBe("Kickoff 21:30, need 8 more.");
  });
});

describe("the format-switch line is the server's, and only when it applies", () => {
  const confirmedNames = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const five = [{ sportName: "Football 5-a-side", totalPlayers: 10 }];

  it("short, within 24 hours and viable: the proposal line", () => {
    const line = chaseSwitchLine({ confirmedNames, maxPlayers: 14, alternatives: five, lang: "en", hoursToKickoff: 20 });
    expect(line).toMatch(/^If we don't find 4 more, we could switch to 5-a-side \(10 players\)/);
  });

  it("further out than 24 hours: nothing", () => {
    expect(chaseSwitchLine({ confirmedNames, maxPlayers: 14, alternatives: five, lang: "en", hoursToKickoff: 30 })).toBeNull();
  });

  it("not viable (the smaller format is not filled either): nothing", () => {
    expect(chaseSwitchLine({ confirmedNames: confirmedNames.slice(0, 6), maxPlayers: 14, alternatives: five, lang: "en", hoursToKickoff: 20 })).toBeNull();
  });

  it("no smaller format: nothing", () => {
    expect(chaseSwitchLine({ confirmedNames, maxPlayers: 14, alternatives: [], lang: "en", hoursToKickoff: 20 })).toBeNull();
  });
});

describe("assembleChasePost", () => {
  const roster = buildSquadRosterBlock({ confirmed: [{ name: "Ali" }, { name: "Dan" }], bench: [{ name: "Sam" }], maxPlayers: 14, lang: "en" });

  it("lead, then the switch line, then the roster, a blank line apart", () => {
    expect(assembleChasePost({ lead: "L", switchLine: "S", rosterBlock: roster })).toBe(`L\n\nS\n\n${roster}`);
  });

  it("without the roster when the group has just seen it", () => {
    expect(assembleChasePost({ lead: "L", switchLine: null, rosterBlock: null })).toBe("L");
  });
});
