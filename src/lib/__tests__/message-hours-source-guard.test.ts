/**
 * SOURCE GUARD: there is ONE definition of the daytime window.
 *
 * `src/lib/message-hours.ts` holds the only pair of hours (09:00 to 23:00
 * London) that says when MatchTime may send a held message. Until
 * 2026-10-13 nine files each carried their own 8 and 22. This test fails
 * when a file under `src/` brings that back:
 *
 *   1. one of the old constant names;
 *   2. an hour constant set to 8, 9, 22 or 23;
 *   3. a comparison shaped like a window (`>= 8 && h < 22`, `< 9 || h >= 23`);
 *   4. a wall clock string "08:00", "22:00" or "23:00".
 *
 * A genuinely different schedule (one hour of the day, a default time) is
 * allow-listed below BY NAME, with the reason. To add a new gate on the
 * daytime window, call `inMessageHours` or `messageHoursSendAfter`; do not
 * add to the allow-list.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_HOURS_FROM_HOUR, MESSAGE_HOURS_FROM_TIME, MESSAGE_HOURS_TO_HOUR } from "../message-hours";

const SRC = path.resolve(__dirname, "../..");
const OWNER = "lib/message-hours.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "__fixtures__" || name === "generated" || name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments out, so prose about "08:00" or an old name in a note is not code. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

const FILES = sourceFiles(SRC).map((full) => ({ rel: path.relative(SRC, full).split(path.sep).join("/"), text: code(readFileSync(full, "utf8")) }));

/** The names the nine private copies of the window went by. */
const OLD_NAMES = [
  "QUIET_FROM_HOUR",
  "QUIET_UNTIL",
  "NOTICE_FROM_HOUR",
  "NOTICE_QUIET_FROM_HOUR",
  "NOTICE_LAST_HOUR_EXCLUSIVE",
  "LIST_FROM_HOUR",
  "LIST_QUIET_FROM_HOUR",
  "WAKING_FROM_HOUR",
  "DAY_FROM_HOUR",
  "ADMIN_GROUP_POST_FROM_HOUR",
  "ADMIN_GROUP_POST_TO_HOUR",
  "RECRUIT_CHASE_HOUR_START",
  "RECRUIT_CHASE_HOUR_END",
];

/** Hour constants that are 8, 9, 22 or 23 for a reason of their own. */
const ALLOWED_HOUR_CONSTANTS: Record<string, string> = {
  "lib/bot-scheduler.ts:MOM_EARLY_FROM_HOUR": "Man of the Match early trigger, 09:00 to 20:59: a schedule for one post",
  "lib/reminder-time.ts:DEFAULT_HOUR": "the time a player's reminder gets when they name a day but no time",
};

/** Wall clock strings that are a schedule, not the window. */
const ALLOWED_CLOCK_STRINGS: Record<string, string> = {
  "lib/rolling-squad-rules.ts:08:00": "ROLLING_SEED_HOUR: when the squad is carried over (a database write, not a message)",
};

describe("message-hours.ts is the one definition of the daytime window", () => {
  it("the window is 09:00 to 23:00", () => {
    expect(MESSAGE_HOURS_FROM_HOUR).toBe(9);
    expect(MESSAGE_HOURS_TO_HOUR).toBe(23);
    expect(MESSAGE_HOURS_FROM_TIME).toBe("09:00");
  });

  it("the scan reads the tree (it is not passing on nothing)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.some((f) => f.rel === OWNER)).toBe(true);
    expect(FILES.some((f) => f.rel === "lib/bot-scheduler.ts")).toBe(true);
  });

  it("no file uses one of the old window constant names", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      for (const name of OLD_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(f.text)) hits.push(`${f.rel}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no hour constant is 8, 9, 22 or 23 outside message-hours.ts (allow-list by name)", () => {
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const f of FILES) {
      if (f.rel === OWNER) continue;
      for (const m of f.text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*HOUR[A-Z0-9_]*)\s*(?::\s*number\s*)?=\s*(8|9|22|23)\s*;/g)) {
        const key = `${f.rel}:${m[1]}`;
        seen.add(key);
        if (!(key in ALLOWED_HOUR_CONSTANTS)) hits.push(`${key} = ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
    // An allow-list entry that no longer matches anything is stale: remove it.
    expect(Object.keys(ALLOWED_HOUR_CONSTANTS).filter((k) => !seen.has(k))).toEqual([]);
  });

  it("no comparison is shaped like the window (>= 8|9 && < 22|23, or its negation)", () => {
    const inside = /(?:>=\s*(?:8|9)|>\s*(?:7|8))\s*&&[^;\n]{0,60}?(?:<\s*(?:22|23)|<=\s*(?:21|22))\b/;
    const outside = /<\s*(?:8|9)\s*\|\|[^;\n]{0,60}?>=\s*(?:22|23)\b/;
    const outsideReversed = />=\s*(?:22|23)\s*\|\|[^;\n]{0,60}?<\s*(?:8|9)\b/;
    const hits: string[] = [];
    for (const f of FILES) {
      if (f.rel === OWNER) continue;
      f.text.split("\n").forEach((line, i) => {
        if (inside.test(line) || outside.test(line) || outsideReversed.test(line)) hits.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('no wall clock string "08:00", "22:00" or "23:00" outside message-hours.ts (allow-list by file)', () => {
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const f of FILES) {
      if (f.rel === OWNER) continue;
      // Only a string that is exactly the time: prose in the copy tables is not a gate.
      for (const m of f.text.matchAll(/(["'`])(08:00|22:00|23:00)\1/g)) {
        const key = `${f.rel}:${m[2]}`;
        seen.add(key);
        if (!(key in ALLOWED_CLOCK_STRINGS)) hits.push(key);
      }
    }
    expect(hits).toEqual([]);
    expect(Object.keys(ALLOWED_CLOCK_STRINGS).filter((k) => !seen.has(k))).toEqual([]);
  });

  it("every file named in message-hours.ts's CLUB gates reads the club's quiet hours", () => {
    // The header's list is the record of which messages wait. A file on it
    // that no longer passes the club's quiet hours anywhere has silently
    // stopped waiting (2026-10-21: the pay links were never on it, and went
    // out at 08:14).
    const header = readFileSync(path.join(SRC, OWNER), "utf8");
    const block = header.slice(header.indexOf("CLUB gates"), header.indexOf("PLATFORM gates"));
    const named = [...new Set([...block.matchAll(/\b([a-z0-9-]+(?:\/[a-z0-9-]+)?\.ts)\b/g)].map((m) => m[1]))];
    // The 2026-10-21 per-match payment files must be on the list.
    for (const f of ["payment-flow.ts", "fee-waiver.ts", "direct-payment.ts", "bot-scheduler.ts"]) expect(named).toContain(f);
    const READS = /\b(?:quietHoursOf|loadClubQuietHours|quietHours|QuietHours|messageHoursSendAfter|adminNoticeSendAfter)\b/;
    const missing = named.filter((f) => {
      const file = FILES.find((x) => x.rel === `lib/${f}`);
      return !file || !READS.test(file.text);
    });
    expect(missing).toEqual([]);
  });

  it("the guard's own patterns catch the shapes that were removed", () => {
    const inside = /(?:>=\s*(?:8|9)|>\s*(?:7|8))\s*&&[^;\n]{0,60}?(?:<\s*(?:22|23)|<=\s*(?:21|22))\b/;
    expect(inside.test("if (lh >= 8 && lh < 22) {")).toBe(true);
    expect(inside.test("return h >= 9 && h < 23;")).toBe(true);
    expect(inside.test("return hour >= DAY_FROM_HOUR && hour < 22;")).toBe(false);
    // One-hour schedules are not the window.
    expect(inside.test("const inMorningWindow = hour >= 8 && hour < 9;")).toBe(false);
    expect(inside.test("const inAnnounceWindow = lh >= 9 && lh < 13;")).toBe(false);
    expect(code("const a = 1; // QUIET_FROM_HOUR was here\n/* 08:00 */ const b = 2;")).not.toMatch(/QUIET_FROM_HOUR|08:00/);
    expect(code('const url = "https://x.test/a"; const t = "08:00";')).toContain('"08:00"');
  });
});
