/**
 * FORMAT-SWITCH BENCH CLAIMS — LIVE-LLM validation.
 *
 * Drives the REAL Anthropic model over the exact production scenario of
 * 2026-08-30. MatchTime posted this to a real customer group with EIGHT
 * confirmed players:
 *
 *   "If we don't find 6 more, we could switch to 5-a-side (10 players)
 *    — Najib + Mojib + Mustafa go on the bench. Admins can rebook and
 *    flip it in the portal."
 *
 * 5-a-side fields TEN players in total, so a switch would have benched
 * nobody — and 8 doesn't fill 10 anyway, so the switch was never on. The
 * model had subtracted players-per-TEAM (8 - 5 = 3) instead of the format
 * TOTAL, then picked three real people to tell they were losing their
 * place. The sentence even contradicts itself.
 *
 * The fix moves the arithmetic and the name-picking into code
 * (src/lib/format-switch.ts) and hands the model a finished sentence. A
 * stubbed test cannot prove that: it would only assert our assumed
 * verdict. So this spec runs the real model, several times, and asserts
 * the reply never tells a confirmed player they are benched.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1. Default suites SKIP it.
 *
 * Run:
 *   ANTHROPIC_API_KEY=<key> MT_SIM_LIVE_LLM=1 \
 *     npx tsx e2e/run.ts sim/format-switch-live.spec.ts
 *   (or: npm run test:sim:live:format  with ANTHROPIC_API_KEY exported)
 *
 * NEVER weaken these assertions — tighten the prompt (or move more of the
 * sentence into code) until they hold.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 5; // the model is non-deterministic — repeat every case

/** Squad keys in position order; the production squad was 8 strong. */
const EIGHT = ["owner", "alice", "brian", "pete", "dan", "felix", "greg", "henry"];
const TWELVE = [...EIGHT, "ivan", "jake", "kyle", "liam"];

/**
 * Every sentence in `text` that tells one of `names` they are going to
 * the bench. This is the assertion that matters: a false "you're
 * benched" is the trust failure we shipped.
 */
function benchAccusations(text: string, names: readonly string[]): string[] {
  const BENCH_CUE =
    /\b(?:go(?:es)?|going|would\s+go|drop(?:s|ping)?|move(?:s|d)?|sit(?:s|ting)?|bench(?:ed)?)\b[^.!?\n]*\bbench\b|\bbench\b[^.!?\n]*\b(?:go(?:es)?|drop(?:s|ping)?|sit(?:s|ting)?)\b/i;
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    if (!BENCH_CUE.test(sentence)) continue;
    for (const full of names) {
      const first = full.split(" ")[0];
      const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(sentence)) {
        out.push(sentence.trim());
        break;
      }
    }
  }
  return out;
}

(LIVE ? test.describe : test.describe.skip)(
  "format-switch bench claims LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    /**
     * 7-a-side (14) group with a 5-a-side (10) alternative Activity
     * configured, kickoff a few hours away so the format-switch
     * conditions are live. `confirmedKeys` seeds the squad in order.
     */
    async function mkGroup(
      request: APIRequestContext,
      db: TestDb,
      confirmedKeys: string[],
    ): Promise<SimGroup> {
      const grp = await createGroup(request, db, {
        maxPlayers: 14, // 7-a-side → sport.playersPerTeam = 7
        attendance: confirmedKeys.map((key) => ({ key, status: "CONFIRMED" as const })),
      });
      // Kickoff in ~5h (proximity "tonight", inside the ~24h window the
      // format-switch proposal requires). Deadline still ahead of us so
      // late IN/OUT still register.
      const kickoff = new Date(Date.now() + 5 * 60 * 60 * 1000);
      await grp.db.run(
        `UPDATE "Match" SET date = $1, "attendanceDeadline" = $2 WHERE id = $3`,
        [kickoff, new Date(kickoff.getTime() - 60 * 60 * 1000), grp.matchId],
      );
      // The 5-a-side alternative: same sport family ("Football"), fewer
      // players per team. maxPlayers semantics = playersPerTeam * 2 = 10.
      const sid = `${grp.orgId}-sport-5aside`;
      await grp.db.run(
        `INSERT INTO "Sport" (id, "orgId", name, preset, "playersPerTeam", positions, "teamLabels", "updatedAt")
         VALUES ($1, $2, 'Football 5-a-side', 'football-5aside', 5, $3, $4, now())`,
        [sid, grp.orgId, ["GK", "DEF", "MID", "FWD"], ["Red", "Yellow"]],
      );
      await grp.db.run(
        `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "updatedAt")
         VALUES ($1, $2, $3, 'Tuesday 5-a-side', 2, '20:00', 'Sim Arena', now())`,
        [`${grp.orgId}-act-5aside`, grp.orgId, sid],
      );
      return grp;
    }

    /** Everything the bot said in one exchange: reply + any group post. */
    const allText = (r: { reply: string | null; groupPosts: string[] }) =>
      [r.reply ?? "", ...r.groupPosts].join("\n");

    // ── THE PRODUCTION SCENARIO ─────────────────────────────────────────
    // 8 confirmed, 7-a-side (14), a 5-a-side (10) alternative on file, a
    // player drops so the squad is short and MT composes a squad-state
    // reply. A switch to 5-a-side benches NOBODY (8 < 10) and isn't even
    // viable. No confirmed player may be told they're on the bench.

    test(`PRODUCTION CASE — drop leaves 8/14, 5-a-side available → nobody is told they're benched (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(300_000);
      let proposedSwitch = 0;
      for (let i = 0; i < RUNS; i++) {
        // 9 confirmed; ivan drops → 8, mirroring the real transcript.
        const grp = (await mkGroup(request, db, [...EIGHT, "ivan"])).attach(request);
        const r = await grp.post("ivan", "Sorry lads, can't make it tonight — my ankle's gone 😞");
        const text = allText(r);
        const squad = await grp.confirmed();
        const mentionsSwitch = /5[\s-]?a[\s-]?side|switch|downgrade/i.test(text);
        if (mentionsSwitch) proposedSwitch++;
        const bad = benchAccusations(text, squad);
        console.log(
          `[format-switch-live] PROD run ${i + 1}: confirmed=${squad.length} switchMentioned=${mentionsSwitch} benchAccusations=${bad.length}` +
            (bad.length ? ` :: ${JSON.stringify(bad)}` : "") +
            `\n---- MT said ----\n${text}\n-----------------`,
        );
        // The bot must not go silent on a drop that leaves the squad short.
        expect(text.trim(), `run ${i + 1}: MT said nothing about a squad-shortening drop`).not.toBe("");
        expect(squad.length, `run ${i + 1}: squad should be short`).toBeLessThan(10);
        expect(
          bad,
          `run ${i + 1}: MT told a confirmed player they go on the bench, but a switch to 5-a-side benches NOBODY at ${squad.length} confirmed.\nFull text:\n${text}`,
        ).toEqual([]);
        // The self-contradicting shape from production: "(10 players)"
        // immediately followed by names being benched.
        expect(
          /\(10 players\)[^.!?\n]*\bbench\b/i.test(text),
          `run ${i + 1}: a 10-player format cannot bench anyone from a squad of ${squad.length}.\n${text}`,
        ).toBe(false);
      }
      console.log(`[format-switch-live] PROD: switch mentioned in ${proposedSwitch}/${RUNS} runs`);
    });

    test(`DIRECT QUESTION — "should we switch to 5 a side?" at 8/14 → no bench accusations (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(300_000);
      let honestNo = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db, EIGHT)).attach(request);
        const r = await grp.post("jake", "@Match Time should we switch to 5 a side?", { tag: true });
        const text = allText(r);
        const squad = await grp.confirmed();
        const bad = benchAccusations(text, squad);
        // We only have 8 — the honest answer is that 5-a-side needs 10.
        // The honest answer names the real gap (10 needed, 8 confirmed).
        const saysNo =
          /don'?t have the numbers|not enough|haven'?t got|only got|still short|\bno\b|can'?t|won'?t (?:fill|work)/i.test(
            text,
          ) && /\b10\b/.test(text);
        if (saysNo) honestNo++;
        console.log(
          `[format-switch-live] Q run ${i + 1}: confirmed=${squad.length} honestNo=${saysNo} benchAccusations=${bad.length}` +
            (bad.length ? ` :: ${JSON.stringify(bad)}` : "") +
            `\n---- MT said ----\n${text}\n-----------------`,
        );
        // A tagged, direct question must get an answer.
        expect(text.trim(), `run ${i + 1}: MT ignored a tagged direct question`).not.toBe("");
        expect(
          bad,
          `run ${i + 1}: 8 confirmed cannot fill 5-a-side (10) — nobody is benched.\nFull text:\n${text}`,
        ).toEqual([]);
      }
      console.log(`[format-switch-live] DIRECT-Q honest-no rate: ${honestNo}/${RUNS}`);
    });

    // ── POSITIVE CONTROL ────────────────────────────────────────────────
    // The fix must not simply mute the bot. At 12 confirmed a switch to
    // 5-a-side IS viable and benches exactly the LAST TWO. If MT names
    // anyone as benched it must be those two and nobody else.

    test(`POSITIVE CONTROL — 12/14 asking about 5-a-side benches ONLY the last two (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(300_000);
      let namedCorrectly = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db, TWELVE)).attach(request);
        const r = await grp.post("mike", "@Match Time should we switch to 5 a side?", { tag: true });
        const text = allText(r);
        const squad = await grp.confirmed();
        const overflow = squad.slice(10); // code's answer: the last two
        const keep = squad.slice(0, 10);
        const wrongly = benchAccusations(text, keep);
        const named = overflow.every((n) => text.includes(n.split(" ")[0]));
        if (named) namedCorrectly++;
        console.log(
          `[format-switch-live] CONTROL run ${i + 1}: overflow=${JSON.stringify(overflow)} namedBoth=${named} wrongAccusations=${wrongly.length}` +
            (wrongly.length ? ` :: ${JSON.stringify(wrongly)}` : "") +
            `\n---- MT said ----\n${text}\n-----------------`,
        );
        expect(text.trim(), `run ${i + 1}: MT ignored a tagged direct question`).not.toBe("");
        expect(
          wrongly,
          `run ${i + 1}: only ${JSON.stringify(overflow)} lose their slot on a switch to 5-a-side.\nFull text:\n${text}`,
        ).toEqual([]);
      }
      console.log(
        `[format-switch-live] CONTROL both-overflow-names-present: ${namedCorrectly}/${RUNS}`,
      );
    });
  },
);
