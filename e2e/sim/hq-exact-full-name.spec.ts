/**
 * A NAME THAT IS ONE MEMBER'S WHOLE NAME, TYPED IN HQ (FNF, 2026-11-24).
 *
 * FNF HQ, Tue 24 Nov 10:28: the club has "Umar" (booked on the bench for
 * Friday by mistake) and "Umar Noor" (added on the web a minute before).
 * The owner wrote "@Match Time\nUmar out\nUmar Noor In" and then
 * "@Match Time umar out". Both times MatchTime answered "Not sure who
 * Umar is, so I'll leave them out; use the full name": who-is-who (the
 * model that says which member a name is) read "Umar" as either of the
 * two, although "Umar" is exactly one member's whole name and "Umar Noor"
 * exactly the other's. What the owner meant: Umar out, Umar Noor in (on
 * the bench: the squad is 18 of 18).
 *
 * Each case starts from a fresh copy of that state (FNF's own roster in
 * membership order, Umar Noor last, an 18-place game, 18 playing, Umar on
 * the bench) and sends tagged HQ messages from an organiser through the
 * real route.
 *
 *   STUBBED (always runs): the router and the HQ squad reader are stubbed,
 *     who-is-who is the test stand-in (a whole name of exactly one member
 *     is that member). Proves everything from the picks on: Umar out, Umar
 *     Noor to the bench, one "Done" line, no "use the full name".
 *   LIVE (MT_SIM_LIVE_LLM=1, spends ANTHROPIC_API_KEY_DEV): the REAL
 *     router, HQ squad reader and who-is-who on the same messages. This is
 *     the case that failed in production.
 *
 *   npx tsx e2e/run.ts sim/hq-exact-full-name.spec.ts
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/hq-exact-full-name.spec.ts
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { changeReading, clearHqSquadReaderStub, clearPipelineStubs, engineOn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000092@g.us";

/** FNF's members in membership order (prod, read-only, 24 Nov), "?" left out. */
const MEMBERS: Array<{ name: string; role?: "OWNER" | "ADMIN"; aliases?: string[] }> = [
  { name: "Hamzah", role: "OWNER" },
  { name: "Raihan", role: "ADMIN" },
  { name: "Imz", role: "ADMIN" },
  ...["Rafi"].map((name) => ({ name })),
  { name: "Abdul-Hafeez", aliases: ["ah"] },
  ...["AK", "Nasir", "Wasim", "Mo", "Akram", "Bilal", "Hamza", "Kieran", "Maj", "Mojib", "Seb", "Yorel", "Feroz", "Mahir", "Ali", "Alamgir", "Habib", "Yaseen"].map((name) => ({ name })),
  { name: "Najib", aliases: ["uncle najib", "uncle"] },
  ...["Uways", "Umar", "Leo"].map((name) => ({ name })),
  { name: "Imti", aliases: ["imtiaz"] },
  ...["Monts", "Hanad", "Imran", "Omar Laher", "Naim", "Anfal", "Omar", "Andrew", "Maahi", "Shehryar", "Niro", "Irfan", "Mez", "Yusuf", "Youcef", "Morgan", "Bilz", "Kieran R"].map((name) => ({ name })),
  { name: "Kemal", role: "ADMIN" },
  ...["Shaq", "Juned", "Qash", "Clarence", "Biggz", "Lil Mo", "Umar Noor"].map((name) => ({ name })),
];

/** 18 playing, then the bench, Umar on it by mistake. */
const PLAYING = ["Mo", "Mojib", "Alamgir", "Feroz", "Yaseen", "Rafi", "Abdul-Hafeez", "Najib", "Hamzah", "Yorel", "Akram", "Shehryar", "Maj", "Niro", "Imti", "Seb", "Clarence", "Imz"];
const BENCH = ["Wasim", "Bilal", "Andrew", "Umar"];

/** The sender, an organiser, plays the part of Imz (the fixture admin's phone). */
const idOf = (name: string): string =>
  name === "Imz" ? U.admin : name === "Hamzah" ? U.collector : `e2e-fnf-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

async function seedFnf(db: TestDb, members = MEMBERS, bench = BENCH): Promise<void> {
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser', language = 'en' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  await db.run(`DELETE FROM "UserAlias" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "Membership" WHERE "orgId" = $1`, [ORG_ID]);
  const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [i, m] of members.entries()) {
    const id = idOf(m.name);
    if (id === U.admin || id === U.collector) {
      await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [id, m.name]);
    } else {
      await db.run(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET name = $2`, [
        id,
        m.name,
        `${id}@e2e.test`,
      ]);
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
  await db.run(`UPDATE "Match" SET "maxPlayers" = 18 WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "Attendance" WHERE "matchId" = $1`, [MATCH.upcoming]);
  const listedAt = Date.now() - 24 * 60 * 60 * 1000;
  const rows: Array<[string, "CONFIRMED" | "BENCH"]> = [...PLAYING.map((n) => [n, "CONFIRMED"] as [string, "CONFIRMED"]), ...bench.map((n) => [n, "BENCH"] as [string, "BENCH"])];
  for (const [i, [name, status]] of rows.entries()) {
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

const statusOf = async (db: TestDb, name: string): Promise<string | null> =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, idOf(name)]))?.status ?? null;

const confirmedCount = async (db: TestDb): Promise<number> =>
  (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [MATCH.upcoming]))?.n ?? -1;

let seq = 0;
async function say(request: APIRequestContext, text: string): Promise<{ replyText: string | null; outcome?: string; messageId: string }> {
  const messageId = `e2e-hq-fullname-${Date.now()}-${++seq}`;
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: {
      channel: "admin-group",
      botMentioned: true,
      groupId: HQ,
      messageId,
      text,
      senderPhone: PHONE.admin.replace(/^\+/, ""),
      senderName: "Imz",
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { ...(await res.json()), messageId };
}

const BOTH = "@Match Time\nUmar out\nUmar Noor In";
const ONE = "@Match Time umar out";

test.describe("a whole name typed in HQ is that member, even when it starts another member's name (stubbed)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => {
    clearPipelineStubs();
    clearHqSquadReaderStub();
    resetDb();
  });

  test("'Umar out, Umar Noor In': Umar out, Umar Noor to the bench, no 'use the full name'", async ({ request, db }) => {
    resetDb();
    await seedFnf(db);
    engineOn({ [BOTH]: { route: "other_att", reading: changeReading([["Umar", "out"], ["Umar Noor", "in"]], { replaces: { "Umar Noor": "Umar" } }) } });
    const out = await say(request, BOTH);
    expect(out.replyText ?? "").not.toContain("use the full name");
    expect(await statusOf(db, "Umar")).toBe("DROPPED");
    expect(await statusOf(db, "Umar Noor")).toBe("BENCH");
    expect(await confirmedCount(db)).toBe(18);
    expect(out.replyText ?? "").toMatch(/^Done: /);
  });

  test("'umar out': Umar out, Umar Noor untouched", async ({ request, db }) => {
    resetDb();
    await seedFnf(db);
    engineOn({ [ONE]: { route: "other_att", reading: changeReading([["Umar", "out"]]) } });
    const out = await say(request, ONE);
    expect(out.replyText ?? "").not.toContain("use the full name");
    expect(await statusOf(db, "Umar")).toBe("DROPPED");
    expect(await statusOf(db, "Umar Noor")).toBeNull();
    expect(await confirmedCount(db)).toBe(18);
  });

  test("still asks when the name is nobody's whole name and two members start with it", async ({ request, db }) => {
    resetDb();
    // No plain "Umar": "Umar Noor" and "Umar Khan".
    await seedFnf(db, [...MEMBERS.filter((m) => m.name !== "Umar"), { name: "Umar Khan" }], ["Wasim", "Bilal", "Andrew"]);
    engineOn({ [ONE]: { route: "other_att", reading: changeReading([[{ new: "umar" }, "out"]]) } });
    const out = await say(request, ONE);
    expect(out.replyText ?? "").toContain("use the full name");
    expect(await statusOf(db, "Umar Noor")).toBeNull();
    expect(await statusOf(db, "Umar Khan")).toBeNull();
  });
});

(LIVE ? test.describe : test.describe.skip)("a whole name typed in HQ, LIVE (real router, HQ reader and who-is-who)", () => {
  test.afterAll(() => resetDb());

  for (const c of [
    { id: "both", text: BOTH, noor: "BENCH" as string | null },
    { id: "one", text: ONE, noor: null },
  ]) {
    test(`${c.id}: ${JSON.stringify(c.text)}`, async ({ request, db }) => {
      resetDb();
      await seedFnf(db);
      const out = await say(request, c.text);
      const trace = await db.one<{ t: { hqSquadReader?: unknown } | null; outcome: string | null }>(
        `SELECT "pipelineTrace" AS t, "hqOutcome" AS outcome FROM "AdminGroupMessage" WHERE "waMessageId" = $1`,
        [out.messageId],
      );
      const usage = await db.one<{ calls: number; cost: number }>(
        `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`,
        [ORG_ID],
      );
      const result = {
        case: c.id,
        reading: trace?.t?.hqSquadReader ?? null,
        hqOutcome: trace?.outcome ?? null,
        umar: await statusOf(db, "Umar"),
        umarNoor: await statusOf(db, "Umar Noor"),
        confirmed: await confirmedCount(db),
        reply: out.replyText ?? null,
        calls: usage?.calls ?? 0,
        costUsd: usage?.cost ?? 0,
      };
      console.log(`[hq-fullname] ${JSON.stringify(result)}`);
      expect(result.reply ?? "").not.toContain("use the full name");
      expect(result.umar).toBe("DROPPED");
      expect(result.umarNoor).toBe(c.noor);
      expect(result.confirmed).toBe(18);
    });
  }
});
