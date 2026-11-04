/**
 * GUARD, A RATCHET: ONE DERIVE PER FACT (plan section 3.6, 3).
 *
 * `matchNumbers`, `monthPhaseFor` and `pickNextMatch` (club-summary/derive.ts)
 * are meant to be the only places that work out what they work out. On the
 * day they were built (slice A0, 2026-11-04, origin/main 19c75141) other
 * files still do, so this pins today's count per file and fails when:
 *   - a file not listed starts to compute one of these facts itself, or a
 *     listed file computes it more often than today: use the summary;
 *   - a listed file computes it less often than today: lower the number
 *     here (or delete the file's entry), so the ratchet only tightens.
 *
 * The patterns, mechanical on purpose (a comment counts too):
 *   - places: `confirmed < maxPlayers` and `maxPlayers - confirmed` in any
 *     spelling (`confirmed.length`, `m.maxPlayers`): places open, or the
 *     places used as "short" (D1). `matchNumbers`.
 *   - monthRow: `squadMonth.findFirst(`: one month row looked up on its own
 *     (D5). `monthPhaseFor`. Writers reading a row inside their own write are
 *     counted like any other file; a slice that moves a reader off lowers it.
 *   - registration: `selectRegistrationMatch(` fed by a query of its own
 *     (D7). `pickNextMatch`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");

const PATTERNS: Record<string, RegExp> = {
  places: /confirmed(?:\.length)?\s*<\s*(?:m\.)?maxPlayers|maxPlayers\s*-\s*confirmed/g,
  monthRow: /squadMonth\.findFirst\(/g,
  registration: /\bselectRegistrationMatch\(/g,
};

/** Today's counts. Only ever lowered. */
const TODAY: Record<string, Record<string, number>> = {
  places: {
    "app/api/whatsapp/status/route.ts": 1,
    "app/page.tsx": 1,
    "lib/bot-scheduler.ts": 4,
    "lib/chase-risk.ts": 1,
    "lib/deadline-summary.ts": 1,
    "lib/group-copy.ts": 1,
    "lib/monthly-week-asks-rules.ts": 2,
    "lib/monthly-week-asks.ts": 1,
    "lib/monthly-week-rules.ts": 1,
    "lib/pipeline/compose.ts": 4,
    "lib/pipeline/engine.ts": 1,
    "lib/recruit.ts": 1,
    "lib/rolling-squad-rules.ts": 1,
    "lib/squad-announce.ts": 1,
    "lib/squad-short.ts": 1,
  },
  monthRow: {
    "app/actions/month-signup.ts": 1,
    "app/actions/squad-month.ts": 1,
    "app/admin/months/page.tsx": 1,
    "lib/month-close.ts": 1,
    "lib/month-not-started.ts": 1,
    "lib/month-payment.ts": 3,
    "lib/squad-month.ts": 1,
  },
  registration: {
    "app/api/whatsapp/analyze/route.ts": 1,
    "lib/admin-group-paste.ts": 1,
    "lib/admin-onboarding.ts": 1,
    "lib/dm-registration-target.ts": 1,
    "lib/match-graphics.ts": 1,
    "lib/pipeline/load-state.ts": 1,
    "lib/team-proposal.ts": 1,
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (["__tests__", "generated", "node_modules", "club-summary"].includes(name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f), text: readFileSync(f, "utf8") }));

describe.each(Object.entries(PATTERNS))("one derive per fact: %s", (fact, pattern) => {
  const counted: Record<string, number> = Object.fromEntries(
    files.flatMap((f) => {
      const n = f.text.match(pattern)?.length ?? 0;
      return n > 0 ? [[f.rel, n] as const] : [];
    }),
  );

  it("the scan is alive", () => {
    expect(Object.keys(counted).length).toBeGreaterThan(0);
  });

  it("no file computes it more often than on 2026-11-04", () => {
    const more = Object.entries(counted).filter(([f, n]) => n > (TODAY[fact][f] ?? 0));
    expect(more.map(([f, n]) => `${f}: ${n} (was ${TODAY[fact][f] ?? 0})`), `take "${fact}" from the club summary instead`).toEqual([]);
  });

  it("a file that computes it less often has its number lowered (the ratchet only tightens)", () => {
    const fewer = Object.entries(TODAY[fact]).filter(([f, n]) => (counted[f] ?? 0) < n);
    expect(fewer.map(([f, n]) => `${f}: ${counted[f] ?? 0} (listed ${n})`), "lower these in one-derive-guard.test.ts").toEqual([]);
  });
});
