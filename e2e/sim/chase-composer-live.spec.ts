/**
 * THE SCHEDULED CHASE, LIVE-LLM, END TO END (2026-10-20).
 *
 * The composer was rewritten so code renders the post (the squad list,
 * the format-switch line) and the model writes only the opening line.
 * `scripts/chase-at-risk-live.ts` judges the lines on fixtures; this
 * drives the REAL scheduler route (/api/whatsapp/due-posts, clock pinned
 * with x-test-now, preview mode so nothing is claimed) against the seeded
 * club and the REAL model, in English and in Turkish, and checks the post
 * against the database rows:
 *
 *   - the squad list in the post is exactly the rows (names, order,
 *     count, bench), rendered by `buildSquadRosterBlock`;
 *   - every number in the opening line is a fact of the match;
 *   - the line came from the model (not the fixed fallback), is in the
 *     club's language, carries the call-off warning exactly when the
 *     match is at risk, and has no dash.
 *
 * Once each (Kemal's cheap test plan). Opt-in: only runs when
 * MT_SIM_LIVE_LLM=1, on the developer key.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/chase-composer-live.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, MATCH, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { buildSquadRosterBlock } from "../../src/lib/scheduler-copy";
import { chaseFallbackLead, type ChaseKind } from "../../src/lib/chase-lead";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

interface Instruction {
  kind: string;
  key?: string;
  text?: string;
}

async function duePostsAt(request: import("@playwright/test").APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString(), "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

async function squadRows(db: TestDb) {
  const rows = await db.all<{ status: string; name: string | null }>(
    `SELECT a.status, u.name FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
     WHERE a."matchId" = $1 AND a.status IN ('CONFIRMED', 'BENCH') ORDER BY a.position`,
    [MATCH.upcoming],
  );
  const m = (await db.one<{ maxPlayers: number; date: Date; name: string; venue: string }>(
    `SELECT m."maxPlayers", m.date, ac.name, ac.venue FROM "Match" m JOIN "Activity" ac ON ac.id = m."activityId" WHERE m.id = $1`,
    [MATCH.upcoming],
  ))!;
  return {
    confirmed: rows.filter((r) => r.status === "CONFIRMED").map((r) => ({ name: r.name })),
    bench: rows.filter((r) => r.status === "BENCH").map((r) => ({ name: r.name })),
    ...m,
  };
}

const CALL_OFF = { en: /call(?:ed|ing)?\s+(?:it|this|the\s+(?:match|game))\s+off|game's off|cancel/i, tr: /iptal/i };
const ENGLISH_WORDS = /(?<!\p{L})(?:the|we|need|squad|more|still|say|tonight|tomorrow|kickoff)(?!\p{L})/iu;

(LIVE ? test.describe : test.describe.skip)("scheduled chase LIVE (real model, real scheduler route)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(resetDb);

  for (const lang of ["en", "tr"] as const) {
    for (const c of [
      // 17:00 the day before, 4 of 10 confirmed (need 6, about 27h out): at risk.
      { name: "17:00 update, at risk", kind: "daily-in-list" as ChaseKind, maxPlayers: 10, now: () => londonAt(1, 17, 5), key: ":evening-update:", atRisk: true },
      // 18:45 on match day, 4 of 5 (need 1): the last call before the 20:00 kickoff.
      { name: "last call", kind: "pre-kickoff-short" as ChaseKind, maxPlayers: 5, now: () => londonAt(2, 18, 45), key: ":pre-kickoff", atRisk: false },
    ]) {
      test(`${lang}: ${c.name}: the post matches the database`, async ({ request, db }) => {
        await db.run(`UPDATE "Organisation" SET language = $1 WHERE id = $2`, [lang, ORG_ID]);
        await db.run(`UPDATE "Match" SET "maxPlayers" = $1 WHERE id = $2`, [c.maxPlayers, MATCH.upcoming]);
        const now = c.now();
        const post = (await duePostsAt(request, now)).find((i) => i.kind === "group-message" && i.key?.includes(c.key));
        expect(post, `no ${c.key} post`).toBeDefined();
        const text = post!.text!;
        console.log(`[chase-live] ${lang} ${c.name}\n${text}\n`);

        // The squad list is the rows, rendered by code.
        const sq = await squadRows(db);
        const roster = buildSquadRosterBlock({ confirmed: sq.confirmed, bench: sq.bench, maxPlayers: sq.maxPlayers, lang });
        expect(text).toContain(roster);

        // The opening line: everything above the list.
        const lead = text.slice(0, text.indexOf(roster)).trim();
        const kickoff = new Date(sq.date);
        const fallback = chaseFallbackLead({
          kind: c.kind,
          lang,
          activityName: sq.name,
          venue: sq.venue,
          kickoff,
          now,
          confirmed: sq.confirmed.length,
          maxPlayers: sq.maxPlayers,
          bench: sq.bench.length,
          atRisk: c.atRisk,
        });
        expect(lead, "the model's line was not posted (the fixed one went out)").not.toBe(fallback);
        expect(lead).not.toMatch(/[—–]/);
        expect(CALL_OFF[lang].test(lead), `call-off warning ${c.atRisk ? "missing" : "where none belongs"}`).toBe(c.atRisk);

        const need = sq.maxPlayers - sq.confirmed.length;
        const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(kickoff);
        const day = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric" }).format(kickoff));
        // The counts, the kickoff's time and date, the days to go (0 to 2
        // here), and digits in the match's own name or venue ("5-a-side").
        const allowed = new Set([sq.confirmed.length, sq.maxPlayers, need, sq.bench.length, day, 0, 1, 2, ...hm.split(":").map(Number)]);
        for (const src of [sq.name, sq.venue]) for (const d of src.match(/\d+/g) ?? []) allowed.add(Number(d));
        for (const d of lead.match(/\d+/g) ?? []) expect(allowed.has(Number(d)), `number ${d} in "${lead}"`).toBe(true);
        if (lang === "tr") expect(lead.replace(sq.name, "").replace(sq.venue, "")).not.toMatch(ENGLISH_WORDS);
      });
    }
  }
});
