/**
 * AUTO-REGISTER UNTAGGED THIRD-PARTY ADDS — LIVE-LLM validation.
 *
 * Drives the REAL Anthropic model (no stubbed verdict) over the real
 * "Sutton Football Club" transcript to prove the behaviour change:
 *
 *   • A CONCRETE, present/affirmative, NAMED third-party ADD in natural,
 *     UNTAGGED group chat → registers that player (no @Match Time tag).
 *   • Future / unnamed / conditional / hypothetical / question /
 *     informational chatter → registers NOBODY.
 *   • The SENDER who is only relaying is NOT auto-joined (relay guard).
 *
 * Each classification-sensitive case runs RUNS times because the model is
 * non-deterministic; positives must register the right name EVERY run and
 * negatives must register NOBODY every run. The hardest case ("Ayoub
 * snatched that spot") is reported as a hit-rate, not a hard assert.
 *
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * Default suites SKIP it entirely.
 *
 * Run:
 *   ANTHROPIC_API_KEY=<key> MT_SIM_LIVE_LLM=1 \
 *     npx tsx e2e/run.ts sim/auto-register-adds-live.spec.ts
 *   (or: npm run test:sim:live:adds  with ANTHROPIC_API_KEY exported)
 *
 * NEVER weaken these assertions — tune the SYSTEM_PROMPT until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 5; // repeat each classification-sensitive case 5×

(LIVE ? test.describe : test.describe.skip)(
  "auto-register untagged third-party ADDS LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    // Squad 10/14 (7-a-side, full match tomorrow) — mirrors the real
    // transcript. A genuine add lands on the 11th CONFIRMED slot.
    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "brian", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
          { key: "jake", status: "CONFIRMED" },
        ],
      });

    // A (possibly provisioned) player's attendance on the match, by NAME —
    // third-party adds provision a brand-new User with no roster key.
    const attendanceByName = (grp: SimGroup, name: string) =>
      grp.db.one<{ status: string }>(
        `SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
         WHERE a."matchId" = $1 AND u.name ILIKE $2`,
        [grp.matchId, `%${name}%`],
      );

    // ── POSITIVES — must register the named player EVERY run ──────────────

    test(`untagged "Add Rashad please" → registers Rashad, NOT the sender (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // kyle is NOT in the seeded squad — he's only adding Rashad.
        const r = await grp.post("kyle", "Add Rashad please");
        // eslint-disable-next-line no-console
        console.log(
          `[adds-live] add-Rashad run ${i + 1}: intent=${r.intent} react=${r.react} reply=${JSON.stringify((r.reply ?? "").slice(0, 60))} posts=${r.groupPosts.length}`,
        );
        const att = await attendanceByName(grp, "Rashad");
        expect(att, `run ${i + 1}: Rashad must be registered`).not.toBeNull();
        expect(["CONFIRMED", "BENCH"], `run ${i + 1}`).toContain(att!.status);
        // Relay guard: the sender must NOT be auto-joined.
        expect(
          await grp.attendanceOf("kyle"),
          `run ${i + 1}: sender (kyle) must not be auto-joined`,
        ).toBeNull();
        // Visible confirmation: either a ✅/🪑 react or a group post.
        const confirmed =
          r.react === "✅" || r.react === "🪑" || !!r.reply || r.groupPosts.length > 0;
        expect(confirmed, `run ${i + 1}: MT must visibly confirm the add`).toBe(true);
      }
    });

    test(`untagged 2-message "My friends down to play" + "His name is Kieran" → registers Kieran (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.postBatch([
          { player: "liam", body: "My friends down to play" },
          { player: "liam", body: "His name is Kieran" },
        ]);
        // eslint-disable-next-line no-console
        console.log(
          `[adds-live] Kieran-context run ${i + 1}: intents=${r.results.map((x) => x.intent).join(",")} posts=${r.groupPosts.length}`,
        );
        const att = await attendanceByName(grp, "Kieran");
        expect(att, `run ${i + 1}: Kieran must be registered`).not.toBeNull();
        expect(["CONFIRMED", "BENCH"], `run ${i + 1}`).toContain(att!.status);
      }
    });

    // ── BORDERLINE — report hit-rate; do not force a flaky assertion ──────

    test(`untagged "Ayoub snatched that spot 😭" → registers Ayoub (hit-rate, ×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);
      let hits = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("mike", "Ayoub snatched that spot 😭");
        const att = await attendanceByName(grp, "Ayoub");
        const hit = att !== null;
        if (hit) hits++;
        // eslint-disable-next-line no-console
        console.log(
          `[adds-live] Ayoub-borderline run ${i + 1}: intent=${r.intent} registered=${hit}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(`[adds-live] AYOUB HIT-RATE: ${hits}/${RUNS}`);
      // Lenient floor: catches a total regression to never-register. The
      // real signal is the logged hit-rate above — tune the prompt to push
      // it to RUNS/RUNS without making CI flaky.
      expect(hits, `Ayoub hit-rate ${hits}/${RUNS} — see log`).toBeGreaterThanOrEqual(1);
    });

    // ── NEGATIVES — must register NOBODY every run ────────────────────────

    const NEGATIVES: Array<{ sender: string; body: string; why: string }> = [
      { sender: "noah", body: "I can bring 2 players with me for tomorrow", why: "future + unnamed" },
      { sender: "quinn", body: "I'll confirm if anything changes later tonight", why: "future" },
      {
        sender: "ryan",
        body: "I was going to bring 2 guys with me but now I have to break the news to one of them that they are not invited",
        why: "past intention + un-invite",
      },
      {
        sender: "kyle",
        body: "Lemme know if we need more to make it 14. I can find another",
        why: "conditional + unnamed",
      },
      { sender: "liam", body: "Is the 7 a side pitch still booked?", why: "question" },
      {
        sender: "mike",
        body: "Just 1 but amir said he's going to bring 2+ himself so should be 14",
        why: "informational",
      },
    ];

    for (const neg of NEGATIVES) {
      test(`untagged "${neg.body.slice(0, 42)}…" (${neg.why}) → registers NOBODY (×${RUNS})`, async ({
        request,
        db,
      }) => {
        test.setTimeout(240_000);
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          const before = await grp.counts();
          const r = await grp.post(neg.sender, neg.body);
          // eslint-disable-next-line no-console
          console.log(
            `[adds-live] NEG "${neg.body.slice(0, 32)}…" run ${i + 1}: intent=${r.intent} react=${r.react}`,
          );
          const after = await grp.counts();
          // No new registration anywhere (no add of a third party, and no
          // self-join of the sender).
          expect(after.confirmed, `run ${i + 1}: confirmed must not grow`).toBe(before.confirmed);
          expect(after.bench, `run ${i + 1}: bench must not grow`).toBe(before.bench);
        }
      });
    }
  },
);
