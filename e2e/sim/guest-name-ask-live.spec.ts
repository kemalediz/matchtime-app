/**
 * UNNAMED-GUEST NAME ASK — LIVE-LLM validation.
 *
 * WHY (production, 2026-08-31): Amir posted in the club group
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * and MatchTime said NOTHING. PR #26 had just fixed the WRITE half of
 * that incident (the sender is no longer benched for offering someone
 * else), but `bring_guests_vague` sits in ACTIONY_INTENTS, so an
 * untagged one is forced to noise. The club owner had to type
 *
 *     "yes pls, can you share the name?"
 *
 * himself before the guest could be registered. He asked for MatchTime
 * to ask for the name itself.
 *
 * A stubbed sim cannot prove this end of it: whether MatchTime speaks at
 * all depends on the REAL model classifying the message as an unnamed
 * guest offer rather than as the sender's own conditional, or as a
 * registerFor for a person literally called "Amir's brother". So the
 * verdict has to come from the real model, repeated, because it is
 * non-deterministic.
 *
 * HISTORY IS MANDATORY HERE. PR #26 discovered the sim was not sending
 * the chat-history block that production sends on EVERY analyze call, so
 * every earlier live test ran against a prompt production never uses.
 * The last thing in Sutton's buffer was MatchTime's own roster post
 * saying the squad was seven short, and that "we need 7 more" framing
 * above the message is exactly what makes "if needed" read as a
 * squad-state contingency. Every case below carries it.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:guest-name
 *   # or: MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/guest-name-ask-live.spec.ts
 *
 * NEVER weaken these assertions — tune the analyzer prompt until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 5);

/** The server-composed ask (src/lib/guest-name-ask.ts). */
const ASK_RE = /what(?:'s| is| are) their names?\?/i;

(LIVE ? test.describe : test.describe.skip)(
  "unnamed-guest name ask LIVE (real Anthropic model)",
  () => {
    // NOT serial: a hit-rate report is worthless if the first failure
    // skips the rest.
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    // 8/14 with one drop — the real Sutton squad state at 30/08 23:03
    // London, the moment the incident fired.
    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        players: [
          { key: "owner", name: "Oscar Owner", role: "OWNER" },
          { key: "alice", name: "Alice Admin", role: "ADMIN" },
          { key: "amir", name: "Amir Ahmadi" },
          { key: "enayem", name: "Enayem Rashid" },
          { key: "pete", name: "Pete Power" },
          { key: "dan", name: "Dan Drummer" },
          { key: "felix", name: "Felix Fox" },
          { key: "greg", name: "Greg Gale" },
          { key: "henry", name: "Henry Hill" },
          { key: "ivan", name: "Ivan Ice" },
          { key: "jake", name: "Jake Jolly" },
          { key: "noah", name: "Noah North" },
          { key: "quinn", name: "Quinn Quick" },
          { key: "ryan", name: "Ryan Reef" },
        ],
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
          { key: "henry", status: "CONFIRMED" },
          { key: "ivan", status: "CONFIRMED" },
          { key: "jake", status: "DROPPED" },
        ],
      });

    /** The Pi's last-15 buffer as it stood when the incident fired. */
    const PROD_HISTORY = [
      {
        authorName: "MatchTime",
        body:
          "🗓 *Tuesday 7-a-side* — Tue 1 Sept, 21:30 at Goals North Cheam.\n\n" +
          "*Confirmed (7/14):*\n1. Oscar Owner\n2. Alice Admin\n3. Pete Power\n4. Dan Drummer\n" +
          "5. Felix Fox\n6. Greg Gale\n7. Henry Hill\n\n" +
          "We need *7 more*. Reply *IN* to grab a spot.",
      },
      { authorName: "Ivan Ice", body: "IN" },
      { authorName: "Quinn Quick", body: "https://www.instagram.com/reel/DaClAuzs1eQ/" },
      { authorName: "Ryan Reef", body: "Happy Holiday" },
    ];

    const anyAttendanceRow = async (grp: SimGroup) =>
      grp.db.all<{ name: string | null; status: string }>(
        `SELECT u.name, a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
         WHERE a."matchId" = $1 AND a.status <> 'DROPPED'`,
        [grp.matchId],
      );

    const attendanceByName = (grp: SimGroup, name: string) =>
      grp.db.one<{ status: string }>(
        `SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
         WHERE a."matchId" = $1 AND u.name ILIKE $2`,
        [grp.matchId, `%${name}%`],
      );

    /** Nobody called "brother"/"mate"/"someone" may exist as a member. */
    const ghostMember = (grp: SimGroup) =>
      grp.db.one<{ name: string }>(
        `SELECT name FROM "User"
         WHERE name ILIKE '%brother%' OR name ILIKE '%my mate%' OR name = 'someone'`,
        [],
      );

    // ── THE ASK CASES — MatchTime must speak, and must write nothing ───

    const ASK_CASES: Array<{ label: string; sender: string; body: string }> = [
      {
        // The production message, verbatim, untagged. "@Kemal Ediz"
        // tags a HUMAN, not the bot.
        label: "@Kemal Ediz my brother can play if needed",
        sender: "amir",
        body: "@Kemal Ediz my brother can play if needed",
      },
      {
        label: "my brother can play if needed",
        sender: "noah",
        body: "my brother can play if needed",
      },
      {
        label: "I can bring someone if you're short",
        sender: "quinn",
        body: "I can bring someone if you're short",
      },
      {
        label: "my mate could fill in if you're short",
        sender: "ryan",
        body: "my mate could fill in if you're short",
      },
    ];

    for (const c of ASK_CASES) {
      test(`"${c.label}" → asks for the name, writes nothing (×${RUNS})`, async ({
        request,
        db,
      }) => {
        test.setTimeout(420_000);
        let hits = 0;
        const failures: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          const before = await anyAttendanceRow(grp);
          const r = await grp.post(c.sender, c.body, { history: PROD_HISTORY });
          const after = await anyAttendanceRow(grp);
          const sender = await grp.attendanceOf(c.sender);
          const ghost = await ghostMember(grp);
          // eslint-disable-next-line no-console
          console.log(
            `[guest-ask-live] "${c.label}" run ${i + 1}: intent=${r.intent} react=${r.react} ` +
              `sender=${sender ? sender.status : "NO ROW"} ghost=${ghost ? ghost.name : "none"} ` +
              `reply=${JSON.stringify(r.reply ?? null)}`,
          );
          const problems: string[] = [];
          if (!r.reply || !ASK_RE.test(r.reply)) problems.push(`reply=${JSON.stringify(r.reply)}`);
          if (sender) problems.push(`sender got a ${sender.status} row`);
          if (ghost) problems.push(`ghost member "${ghost.name}" created`);
          if (after.length !== before.length) problems.push(`roster changed ${before.length}→${after.length}`);
          if (r.react) problems.push(`reacted ${r.react}`);
          if (problems.length === 0) hits++;
          else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[guest-ask-live] HIT-RATE "${c.label}": ${hits}/${RUNS}`);
        expect(
          failures.join(" | "),
          `an unnamed guest offer must earn a name-ask and NO attendance write`,
        ).toBe("");
        expect(hits).toBe(RUNS);
      });
    }

    // ── CONTROL: a NAMED guest is registered, and NOT asked for a name ──

    test(`CONTROL "my brother Shahrokh can play" → Shahrokh IN, no name-ask (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("noah", "my brother Shahrokh can play", {
          history: PROD_HISTORY,
        });
        const guest = await attendanceByName(grp, "Shahrokh");
        const sender = await grp.attendanceOf("noah");
        // eslint-disable-next-line no-console
        console.log(
          `[guest-ask-live] CONTROL Shahrokh run ${i + 1}: intent=${r.intent} ` +
            `guest=${guest ? guest.status : "NO ROW"} sender=${sender ? sender.status : "NO ROW"} ` +
            `reply=${JSON.stringify((r.reply ?? "").slice(0, 90))}`,
        );
        const problems: string[] = [];
        if (!guest || (guest.status !== "CONFIRMED" && guest.status !== "BENCH"))
          problems.push(`Shahrokh ${guest ? guest.status : "NOT registered"}`);
        if (sender) problems.push(`sender got a ${sender.status} row`);
        if (r.reply && ASK_RE.test(r.reply)) problems.push("asked for a name we already had");
        if (problems.length === 0) hits++;
        else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[guest-ask-live] HIT-RATE CONTROL "my brother Shahrokh can play": ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `a NAMED guest is registered and never triggers the name-ask`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── CONTROL: the COMBINED message. The sender's row MUST be written ─
    //
    // PR #29 review found the ask branch swallowing the sender's own
    // attendance when one message carried both halves: the branch is
    // terminal, so a verdict reaching it loses its WHOLE payload, not
    // just its registerFor. This is the phrasing the model actually
    // sees, so it is validated live and not only against a stub. The
    // name-ask is deliberately NOT asserted here: losing it on a
    // combined message is the accepted cost, losing attendance is not.

    const COMBINED_CASES: Array<{
      label: string;
      sender: string;
      body: string;
      want: "CONFIRMED" | "DROPPED";
      seedConfirmed?: boolean;
    }> = [
      {
        label: "I'm in, and my brother can play too",
        sender: "noah",
        body: "I'm in, and my brother can play too",
        want: "CONFIRMED",
      },
      {
        label: "I can't make it but my mate can play",
        sender: "pete",
        body: "I can't make it tonight but my mate can play",
        want: "DROPPED",
        seedConfirmed: true,
      },
    ];

    for (const c of COMBINED_CASES) {
      test(`COMBINED "${c.label}" → sender's own row is ${c.want} (×${RUNS})`, async ({
        request,
        db,
      }) => {
        test.setTimeout(420_000);
        let hits = 0;
        const failures: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          if (c.seedConfirmed) await grp.setAttendance(c.sender, "CONFIRMED");
          const r = await grp.post(c.sender, c.body, { history: PROD_HISTORY });
          const sender = await grp.attendanceOf(c.sender);
          const ghost = await ghostMember(grp);
          // eslint-disable-next-line no-console
          console.log(
            `[guest-ask-live] COMBINED "${c.label}" run ${i + 1}: intent=${r.intent} ` +
              `sender=${sender ? sender.status : "NO ROW"} ghost=${ghost ? ghost.name : "none"} ` +
              `reply=${JSON.stringify((r.reply ?? "").slice(0, 90))}`,
          );
          const problems: string[] = [];
          if (sender?.status !== c.want)
            problems.push(`sender=${sender ? sender.status : "NO ROW"}, wanted ${c.want}`);
          if (ghost) problems.push(`ghost member "${ghost.name}" created`);
          if (problems.length === 0) hits++;
          else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[guest-ask-live] HIT-RATE COMBINED "${c.label}": ${hits}/${RUNS}`);
        expect(
          failures.join(" | "),
          `the sender's own attendance must never be swallowed by the name-ask`,
        ).toBe("");
        expect(hits).toBe(RUNS);
      });
    }

    // ── CONTROL: a SELF standing offer is handled as today ─────────────

    test(`CONTROL "I'll be the 14th if you're short" → sender registered, no name-ask (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("noah", "I'll be the 14th if you're short", {
          history: PROD_HISTORY,
        });
        const sender = await grp.attendanceOf("noah");
        // eslint-disable-next-line no-console
        console.log(
          `[guest-ask-live] CONTROL self-offer run ${i + 1}: intent=${r.intent} ` +
            `sender=${sender ? sender.status : "NO ROW"} reply=${JSON.stringify((r.reply ?? "").slice(0, 90))}`,
        );
        const problems: string[] = [];
        if (!sender || (sender.status !== "CONFIRMED" && sender.status !== "BENCH"))
          problems.push(`sender ${sender ? sender.status : "NOT registered"}`);
        if (r.reply && ASK_RE.test(r.reply)) problems.push("wrongly asked for a guest name");
        if (problems.length === 0) hits++;
        else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[guest-ask-live] HIT-RATE CONTROL "I'll be the 14th if you're short": ${hits}/${RUNS}`,
      );
      expect(
        failures.join(" | "),
        `an offer about the SENDER is their own attendance, not a guest`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });

    // ── CONTROL: banter that mentions a mate → total silence ───────────

    const BANTER_CASES: Array<{ label: string; sender: string; body: string }> = [
      {
        label: "my brother watched the game last night lol",
        sender: "quinn",
        body: "my brother watched the game last night lol 😂",
      },
      {
        label: "my mate says the pitch is waterlogged",
        sender: "ryan",
        body: "my mate says the pitch is waterlogged",
      },
    ];

    for (const c of BANTER_CASES) {
      test(`CONTROL banter "${c.label}" → total silence (×${RUNS})`, async ({ request, db }) => {
        test.setTimeout(420_000);
        let hits = 0;
        const failures: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const grp = (await mkGroup(request, db)).attach(request);
          const r = await grp.post(c.sender, c.body, { history: PROD_HISTORY });
          const sender = await grp.attendanceOf(c.sender);
          // eslint-disable-next-line no-console
          console.log(
            `[guest-ask-live] CONTROL banter "${c.label}" run ${i + 1}: intent=${r.intent} ` +
              `react=${r.react} sender=${sender ? sender.status : "NO ROW"} ` +
              `reply=${JSON.stringify((r.reply ?? "").slice(0, 90))}`,
          );
          const problems: string[] = [];
          if (r.reply) problems.push(`replied ${JSON.stringify(r.reply.slice(0, 60))}`);
          if (sender) problems.push(`sender got a ${sender.status} row`);
          if (problems.length === 0) hits++;
          else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[guest-ask-live] HIT-RATE CONTROL banter "${c.label}": ${hits}/${RUNS}`);
        expect(failures.join(" | "), `MatchTime stays silent on banter`).toBe("");
        expect(hits).toBe(RUNS);
      });
    }

    // ── The whole exchange, end to end ────────────────────────────────
    //
    // The production sequence the owner had to drive by hand: the offer,
    // then the name. MatchTime asks, then registers, and asks only once.

    test(`END TO END: offer → ask → name → Shahrokh registered, asked only once (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(420_000);
      let hits = 0;
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);

        const offer = await grp.post("amir", "@Kemal Ediz my brother can play if needed", {
          history: PROD_HISTORY,
        });

        const name = await grp.post("amir", "Shahrokh", {
          history: [
            ...PROD_HISTORY,
            { authorName: "Amir Ahmadi", body: "@Kemal Ediz my brother can play if needed" },
            { authorName: "MatchTime", body: offer.reply ?? "" },
          ],
        });

        const guest = await attendanceByName(grp, "Shahrokh");
        const amir = await grp.attendanceOf("amir");
        // eslint-disable-next-line no-console
        console.log(
          `[guest-ask-live] END TO END run ${i + 1}: ask=${JSON.stringify(offer.reply ?? null)} ` +
            `nameIntent=${name.intent} shahrokh=${guest ? guest.status : "NO ROW"} ` +
            `amir=${amir ? amir.status : "NO ROW"}`,
        );
        const problems: string[] = [];
        if (!offer.reply || !ASK_RE.test(offer.reply)) problems.push("no name-ask on the offer");
        if (!guest) problems.push("Shahrokh NOT registered after the name arrived");
        if (amir) problems.push(`Amir got a ${amir.status} row`);
        if (name.reply && ASK_RE.test(name.reply)) problems.push("asked a SECOND time");
        if (problems.length === 0) hits++;
        else failures.push(`run ${i + 1}: ${problems.join(", ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[guest-ask-live] HIT-RATE END TO END: ${hits}/${RUNS}`);
      expect(
        failures.join(" | "),
        `the whole exchange the owner had to type by hand must now run itself`,
      ).toBe("");
      expect(hits).toBe(RUNS);
    });
  },
);
