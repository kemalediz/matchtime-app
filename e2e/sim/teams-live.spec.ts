/**
 * TEAM NAME GENERATION — LIVE-LLM scenario suite.
 *
 * Drives the REAL Anthropic model (no stubbed verdict) to confirm the
 * analyzer actually populates verdict.teamNames when an admin asks
 * MatchTime to invent the team names — and leaves it null otherwise.
 *
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * Default (`npm run test:sim` / `npm run test:e2e`) SKIPS it entirely, so
 * it never breaks the stubbed suite.
 *
 * Names are non-deterministic, so we assert SHAPE only:
 *   Scenario 1 (ask): Match.teamLabels is a 2-element array of distinct,
 *     non-empty, ≤24-char strings that are NOT "Red"/"Yellow", and the
 *     generation post contains both names.
 *   Scenario 2 (control): Match.teamLabels stays empty and the post uses
 *     Red/Yellow.
 *
 * Run: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/teams-live.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const FULL_ATTENDANCE = [
  { key: "owner", status: "CONFIRMED" as const },
  { key: "alice", status: "CONFIRMED" as const },
  { key: "pete", status: "CONFIRMED" as const },
  { key: "dan", status: "CONFIRMED" as const },
  { key: "felix", status: "CONFIRMED" as const },
  { key: "greg", status: "CONFIRMED" as const },
  { key: "henry", status: "CONFIRMED" as const },
  { key: "ivan", status: "CONFIRMED" as const },
];

async function matchLabels(grp: SimGroup): Promise<string[]> {
  const row = await grp.db.one<{ teamLabels: string[] }>(
    `SELECT "teamLabels" FROM "Match" WHERE id = $1`,
    [grp.matchId!],
  );
  return row?.teamLabels ?? [];
}

(LIVE ? test.describe : test.describe.skip)(
  "team name generation LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    test("Scenario 1 — admin asks MT to invent fun names → distinct non-default pair persisted + shown", async ({
      request,
      db,
    }) => {
      test.setTimeout(120_000); // real Anthropic call can take 10–60s

      const grp = (
        await createGroup(request, db, {
          maxPlayers: 8,
          attendance: FULL_ATTENDANCE,
        })
      ).attach(request);

      expect(await matchLabels(grp)).toEqual([]);

      // No verdict — the live model must populate teamNames itself.
      const r = await grp.post(
        "alice",
        "@Match Time generate the teams — you pick some fun team names for us this week",
      );

      const labels = await matchLabels(grp);
      // eslint-disable-next-line no-console
      console.log(`[teams-live] Scenario 1 picked: ${JSON.stringify(labels)}`);
      // Shape: exactly two distinct, non-empty, ≤24-char, non-default names.
      expect(labels).toHaveLength(2);
      for (const l of labels) {
        expect(typeof l).toBe("string");
        expect(l.trim().length).toBeGreaterThan(0);
        expect(l.length).toBeLessThanOrEqual(24);
        expect(l.toLowerCase()).not.toBe("red");
        expect(l.toLowerCase()).not.toBe("yellow");
      }
      expect(labels[0].toLowerCase()).not.toBe(labels[1].toLowerCase());

      // Both names appear in the generation post.
      const post = r.reply ?? "";
      expect(post).toContain(labels[0]);
      expect(post).toContain(labels[1]);
    });

    test('Scenario 2 — control: plain "generate the teams" → no override, Red/Yellow used', async ({
      request,
      db,
    }) => {
      test.setTimeout(120_000);

      const grp = (
        await createGroup(request, db, {
          maxPlayers: 8,
          attendance: FULL_ATTENDANCE,
        })
      ).attach(request);

      expect(await matchLabels(grp)).toEqual([]);

      const r = await grp.post("alice", "generate the teams");

      // No naming request → no per-match override.
      expect(await matchLabels(grp)).toEqual([]);

      const post = r.reply ?? "";
      expect(post).toContain("Red");
      expect(post).toContain("Yellow");
    });
  },
);
