/**
 * A SCHEDULED post must never greet the group with a time of day.
 *
 * The incident (2026-09-16, 16:05 London): the rating-promo group post
 * opened "🎯 Morning all — just DM'd every player from last night's
 * Tuesday 7-a-side a personal rating link…". It normally fires in the
 * 08:00 window, but the rating claims were re-issued after an outage and
 * it went out in the late afternoon. Same class as the 2026-09-04
 * "🗓 Quick 5pm update" bug pinned by `chase-no-send-time-stamp.test.ts`:
 * a send-time baked into the words, this time as a greeting rather than
 * a clock.
 *
 * The rule from that incident stands: "we don't need the time on the
 * updates". A scheduled post can fire at any hour once a claim is
 * released or a Pi comes back from an outage, so a greeting that is
 * right 95% of the time and wrong the other 5% is worse than no
 * greeting at all.
 *
 * The two STATIC sites are pinned here, by equality where the copy is
 * fixed and by regex for the ban itself. The third site is the
 * `match-day-morning` compose instruction, which is a prompt rather
 * than a string — it is pinned next door in
 * `chase-no-send-time-stamp.test.ts`, alongside the send-time rules it
 * belongs with.
 *
 * The last describe block is the recurrence guard: no source file may
 * hard-code a "<time of day> all" greeting again. It is a plain text
 * scan, deliberately blunt.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildRatePromoPost,
  buildMatchDayChaseFallback,
} from "@/lib/group-copy";

/** "Morning all", "Evening all," "Afternoon everyone" — a greeting that
 *  claims to know what time it is. */
const GREETING = /\b(morning|afternoon|evening)\b/i;

describe("the rating-promo group post carries no time of day", () => {
  const post = buildRatePromoPost({
    activityName: "Tuesday 7-a-side",
    matchDateLabel: "Tue 15 Sep",
  });

  it("opens with no morning/afternoon/evening greeting", () => {
    expect(
      post,
      "the promo fires 6-36h after kickoff, at any hour from 08:00 onward — it cannot know the time of day",
    ).not.toMatch(GREETING);
  });

  it("does not claim the match was 'last night'", () => {
    // The promo window is 6-36h after kickoff and only requires the
    // London date to have rolled over, so a Saturday lunchtime match
    // gets its promo on Sunday morning. "Last night" is then false.
    expect(post).not.toMatch(/last night/i);
  });

  it("names the match by activity and date instead", () => {
    expect(post).toContain("*Tuesday 7-a-side*");
    expect(post).toContain("Tue 15 Sep");
  });

  it("keeps the emoji and the substance", () => {
    expect(post).toContain("🎯");
    expect(post).toMatch(/DM'd every player/);
    expect(post).toMatch(/rating link/);
    expect(post).toMatch(/better-balanced/);
    expect(post).toContain("Check your DMs from me 👇");
  });
});

describe("the match-day chase fallback carries no time of day", () => {
  const text = buildMatchDayChaseFallback({
    need: 3,
    activityName: "Tuesday 7-a-side",
  });

  it("opens with no morning/afternoon/evening greeting", () => {
    // This one fires in an 8-9am window, so it is the least likely of
    // the three to be wrong — but "least likely" is what the promo was
    // too, until a claim was re-issued at 16:05.
    expect(text).not.toMatch(GREETING);
  });

  it("keeps the emoji, the shortfall and the ask", () => {
    expect(text).toContain("☀️");
    expect(text).toContain("*3 short*");
    expect(text).toContain("*Tuesday 7-a-side*");
    expect(text).toMatch(/takers/i);
  });

  it("pluralises nothing it should not (one short is still 'short')", () => {
    expect(buildMatchDayChaseFallback({ need: 1, activityName: "X" })).toContain("*1 short*");
  });
});

// ── RECURRENCE GUARD ────────────────────────────────────────────────
describe("no source file hard-codes a time-of-day greeting", () => {
  const SRC = path.resolve(__dirname, "../..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "generated" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // The tests themselves quote the banned copy on purpose.
        if (e.name === "__tests__") continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** A line that only TALKS about the banned greeting is fine — the
   *  docblocks explaining the rule, the code comments citing the
   *  incident, and the prompt line that bans it all quote it. What is
   *  banned is a greeting a reader would actually receive. So: skip
   *  comment lines, and skip any line that spells out a prohibition.
   *  (A real offender smuggled onto a line that also says "never" would
   *  slip past; that is the price of a guard that does not parse TS,
   *  and the per-builder tests above cover the two live sites exactly.) */
  const isProseAboutTheRule = (line: string): boolean => {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || /\bnever\b/i.test(t);
  };

  it("has no '<time of day> all' greeting left in src/", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const body = fs.readFileSync(file, "utf8");
      body.split("\n").forEach((line, i) => {
        if (isProseAboutTheRule(line)) return;
        if (/\b(Morning|Afternoon|Evening)\s+(all|everyone|folks|lads)\b/i.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `a scheduled post cannot know the time of day it will actually fire:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
