/**
 * A SWAP WITH THE BENCH TYPED IN HQ: THE PAID CHECK (2026-11-10).
 *
 * FNF HQ, 10 Nov 11:04: Rafi asked "Should we swap Yaseen for Wasim?" and
 * the owner said "if you agree just ask Matchtime to do it". The squad is
 * full (18 of 18), Yaseen is playing and Wasim is on the bench. What the
 * organisers mean: Wasim into the squad, Yaseen to the BENCH (not out).
 *
 * Each case starts from a fresh copy of that state (FNF's own roster and
 * squad order, an 18-place game, organiser-pick bench, no teams) and sends
 * ONE tagged HQ message from an admin through the real route, the REAL
 * router, HQ squad reader and who-is-who (no stub), and the real
 * attendance engine and writers.
 *
 * Opt in: MT_SIM_LIVE_LLM=1 (spends ANTHROPIC_API_KEY_DEV). Skipped
 * otherwise. HQ_SWAP_CASES=a,c runs only those cases.
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-swap-bench-live.spec.ts
 *
 * Prints, per case, the reader's reading, the statuses and positions of
 * both players, the squad count, the HQ reply, anything queued for the
 * players' group or by DM, and the model calls and cost the club was
 * billed (OrgAiUsage).
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000091@g.us";

/** FNF's members in membership order (prod, read-only, 10 Nov), "?" left out. */
const MEMBERS: Array<{ name: string; role?: "OWNER" | "ADMIN"; aliases?: string[] }> = [
  { name: "Hamzah", role: "OWNER" },
  { name: "Raihan", role: "ADMIN" },
  { name: "Imz", role: "ADMIN" },
  { name: "Rafi" },
  { name: "Abdul-Hafeez", aliases: ["ah"] },
  { name: "AK" },
  { name: "Nasir" },
  { name: "Wasim" },
  { name: "Mo" },
  { name: "Akram" },
  { name: "Bilal" },
  { name: "Hamza" },
  { name: "Kieran" },
  { name: "Maj" },
  { name: "Mojib" },
  { name: "Seb" },
  { name: "Yorel" },
  { name: "Feroz" },
  { name: "Mahir" },
  { name: "Ali" },
  { name: "Alamgir" },
  { name: "Habib" },
  { name: "Yaseen" },
  { name: "Najib", aliases: ["uncle najib", "uncle"] },
  { name: "Uways" },
  { name: "Umar" },
  { name: "Leo" },
  { name: "Imti", aliases: ["imtiaz"] },
  { name: "Monts" },
  { name: "Hanad" },
  { name: "Imran" },
  { name: "Omar Laher" },
  { name: "Naim" },
  { name: "Anfal" },
  { name: "Omar" },
  { name: "Andrew" },
  { name: "Maahi" },
  { name: "Shehryar" },
  { name: "Niro" },
  { name: "Irfan" },
  { name: "Mez" },
  { name: "Yusuf" },
  { name: "Youcef" },
  { name: "Morgan" },
  { name: "Bilz" },
  { name: "Kieran R" },
  { name: "Kemal", role: "ADMIN" },
  { name: "Shaq" },
  { name: "Juned" },
  { name: "Qash" },
  { name: "Clarence" },
  { name: "Biggz" },
  { name: "Lil Mo" },
];

/** The next game's list as prod had it (position order). */
const SQUAD: Array<[string, "CONFIRMED" | "BENCH" | "DROPPED"]> = [
  ["Mo", "CONFIRMED"], ["Mojib", "CONFIRMED"], ["Alamgir", "CONFIRMED"], ["Feroz", "CONFIRMED"],
  ["Yaseen", "CONFIRMED"], ["Rafi", "CONFIRMED"], ["Abdul-Hafeez", "CONFIRMED"], ["Najib", "CONFIRMED"],
  ["Hamzah", "CONFIRMED"], ["Yorel", "CONFIRMED"], ["Akram", "CONFIRMED"], ["Shehryar", "CONFIRMED"],
  ["Maj", "CONFIRMED"], ["Niro", "CONFIRMED"], ["Imti", "CONFIRMED"], ["Seb", "CONFIRMED"],
  ["Biggz", "DROPPED"], ["Lil Mo", "DROPPED"], ["Clarence", "CONFIRMED"], ["Imz", "CONFIRMED"],
  ["Wasim", "BENCH"], ["Raihan", "DROPPED"], ["Bilal", "BENCH"], ["Andrew", "BENCH"],
];

/** The sender, an admin, plays the part of Imz (the fixture admin's phone). */
const idOf = (name: string): string =>
  name === "Imz" ? U.admin : name === "Hamzah" ? U.collector : `e2e-fnf-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

async function seedFnf(db: TestDb): Promise<void> {
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser', language = 'en' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  // Only FNF's members are members of the club.
  await db.run(`DELETE FROM "UserAlias" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "Membership" WHERE "orgId" = $1`, [ORG_ID]);
  const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [i, m] of MEMBERS.entries()) {
    const id = idOf(m.name);
    if (id === U.admin || id === U.collector) {
      await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [id, m.name]);
    } else {
      await db.run(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, $2, $3, now())`, [id, m.name, `${id}@e2e.test`]);
    }
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
      `e2e-fnf-mem-${i}`,
      id,
      ORG_ID,
      m.role ?? "PLAYER",
      new Date(base + i * 60_000),
    ]);
    for (const alias of m.aliases ?? []) {
      await db.run(`INSERT INTO "UserAlias" (id, "orgId", "userId", alias, source) VALUES ($1, $2, $3, $4, 'manual')`, [
        `e2e-fnf-al-${i}-${alias.replace(/\s+/g, "-")}`,
        ORG_ID,
        id,
        alias,
      ]);
    }
  }
  // The next game: 18 places, the list as prod has it, no teams.
  await db.run(`UPDATE "Match" SET "maxPlayers" = 18 WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  // The event log is append-only: the new list's events come after the
  // fixture's, so the log still ends where the table is.
  await db.run(`DELETE FROM "Attendance" WHERE "matchId" = $1`, [MATCH.upcoming]);
  const listedAt = Date.now() - 24 * 60 * 60 * 1000;
  for (const [i, [name, status]] of SQUAD.entries()) {
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`, [
      `e2e-fnf-att-${i}`,
      MATCH.upcoming,
      idOf(name),
      status,
      i + 1,
    ]);
    await db.run(
      `INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind", "sourceRef", at)
       VALUES ($1, $2, $3, $4, $5::"AttendanceStatus", $6, 'test-fixture', 'system', 'e2e:seed', $7)`,
      [`e2e-fnf-ev-${i}`, MATCH.upcoming, idOf(name), ORG_ID, status, i + 1, new Date(listedAt + i * 60_000)],
    );
  }
}

interface Row {
  status: string;
  position: number;
}
const rowOf = (db: TestDb, name: string) =>
  db.one<Row>(`SELECT status, position FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, idOf(name)]);

/** Teams made (proposed): the 18 playing, the first nine RED, the rest YELLOW. */
async function makeTeams(db: TestDb): Promise<void> {
  const playing = SQUAD.filter(([, st]) => st === "CONFIRMED").map(([n]) => n);
  for (const [i, name] of playing.entries()) {
    await db.run(`INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4::"Team")`, [
      `e2e-fnf-ta-${i}`,
      MATCH.upcoming,
      idOf(name),
      i < 9 ? "RED" : "YELLOW",
    ]);
  }
  await db.run(`UPDATE "Match" SET status = 'TEAMS_GENERATED' WHERE id = $1`, [MATCH.upcoming]);
}
const teamOf = async (db: TestDb, name: string) =>
  (await db.one<{ team: string }>(`SELECT team FROM "TeamAssignment" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, idOf(name)]))?.team ?? null;

const CASES: Array<{ id: string; text: string; teams?: true }> = [
  { id: "a", text: "@Match Time swap Yaseen for Wasim" },
  { id: "b", text: "@Match Time swap Yaseen and Wasim" },
  { id: "c", text: "@Match Time Wasim in, Yaseen to the bench" },
  { id: "d", text: "@Match Time Wasim instead of Yaseen" },
  { id: "e", text: "@Match Time Yaseen yerine Wasim" },
  { id: "f", text: "@Match Time Yaseen yedeğe, Wasim kadroya" },
  // Still a plain replacement: Yaseen cannot make it, so he is out.
  { id: "g", text: "@Match Time Wasim for Yaseen, Yaseen can't make it" },
  // Teams made: the swap with the bench gives Wasim Yaseen's side...
  { id: "t1", text: "@Match Time swap Yaseen and Wasim", teams: true },
  // ...and a swap between the two sides is still the teams' (no squad change).
  { id: "t2", text: "@Match Time swap Mo and Yorel", teams: true },
];
const ONLY = (process.env.HQ_SWAP_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

(LIVE ? test.describe : test.describe.skip)("a swap with the bench in HQ, LIVE (real model)", () => {
  // Not serial: every case starts from its own fresh state, and one that
  // fails must not hide the others.
  test.afterAll(() => resetDb());

  for (const c of CASES.filter((x) => ONLY.length === 0 || ONLY.includes(x.id))) {
    test(`${c.id}: ${c.text}`, async ({ request, db }) => {
      resetDb();
      await seedFnf(db);
      if (c.teams) await makeTeams(db);
      const jobsBefore = new Set((await db.all<{ id: string }>(`SELECT id FROM "BotJob"`)).map((j) => j.id));
      const messageId = `e2e-live-hq-swap-${c.id}`;
      const res = await request.post("/api/whatsapp/admin-group", {
        headers: KEY,
        data: {
          channel: "admin-group",
          botMentioned: true,
          groupId: HQ,
          messageId,
          text: c.text,
          senderPhone: PHONE.admin.replace(/^\+/, ""),
          senderName: "Imz",
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      const out = await res.json();
      const trace = await db.one<{ t: { hqSquadReader?: unknown } | null; outcome: string | null }>(
        `SELECT "pipelineTrace" AS t, "hqOutcome" AS outcome FROM "AdminGroupMessage" WHERE "waMessageId" = $1`,
        [messageId],
      );
      const counts = await db.one<{ confirmed: number; bench: number }>(
        `SELECT count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed, count(*) FILTER (WHERE status = 'BENCH')::int AS bench FROM "Attendance" WHERE "matchId" = $1`,
        [MATCH.upcoming],
      );
      const jobs = (await db.all<{ id: string; kind: string; phone: string | null; text: string }>(`SELECT id, kind, phone, text FROM "BotJob"`)).filter(
        (j) => !jobsBefore.has(j.id),
      );
      const rounds = await db.all<{ channel: string; reason: string; openPlaces: number }>(
        `SELECT channel, reason, "openPlaces" FROM "OrganiserPickRound" WHERE "matchId" = $1`,
        [MATCH.upcoming],
      );
      const prompts = await db.all<{ userId: string }>(`SELECT "userId" FROM "PendingBenchConfirmation" WHERE "matchId" = $1`, [MATCH.upcoming]);
      const offers = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "BenchSlotOffer" WHERE "matchId" = $1`, [MATCH.upcoming]);
      const usage = await db.one<{ calls: number; cost: number }>(
        `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`,
        [ORG_ID],
      );
      const result = {
        case: c.id,
        text: c.text,
        reading: trace?.t?.hqSquadReader ?? null,
        hqOutcome: trace?.outcome ?? null,
        yaseen: await rowOf(db, "Yaseen"),
        wasim: await rowOf(db, "Wasim"),
        confirmed: counts?.confirmed,
        bench: counts?.bench,
        reply: out.replyText ?? null,
        react: out.react ?? null,
        jobs: jobs.map((j) => ({ kind: j.kind, phone: j.phone, text: j.text })),
        pickRounds: rounds,
        benchPrompts: prompts.map((p) => p.userId),
        benchOffers: offers?.n ?? 0,
        teams: c.teams ? { yaseen: await teamOf(db, "Yaseen"), wasim: await teamOf(db, "Wasim"), mo: await teamOf(db, "Mo"), yorel: await teamOf(db, "Yorel") } : null,
        calls: usage?.calls ?? 0,
        costUsd: usage?.cost ?? 0,
      };
      console.log(`[hq-swap] ${JSON.stringify(result)}`);
      expect(result.confirmed).toBe(18);
      if (c.id === "t2") {
        // A swap between the sides: nobody's place in the squad changes.
        expect(result.reading).toMatchObject({ kind: "teams" });
        expect(result.yaseen?.status).toBe("CONFIRMED");
        expect(result.wasim?.status).toBe("BENCH");
        expect(result.hqOutcome ?? "").toMatch(/^teams-/);
      } else {
        // What the organisers mean, for every swap: Wasim in, Yaseen on the
        // bench, the squad still 18. "g" says Yaseen cannot make it: out.
        expect(result.wasim?.status).toBe("CONFIRMED");
        expect(result.yaseen?.status).toBe(c.id === "g" ? "DROPPED" : "BENCH");
      }
      // With teams made, Wasim takes Yaseen's side (Yaseen was RED).
      if (c.id === "t1") expect(result.teams).toMatchObject({ wasim: "RED", yaseen: null });
      // Nobody is DM'd; the players' group hears only what a squad filling
      // again always says (the full list, once).
      expect(jobs.filter((j) => j.kind === "dm")).toEqual([]);
      expect(jobs.filter((j) => j.kind === "group" && !j.text.includes("Squad complete (18/18)"))).toEqual([]);
    });
  }
});
