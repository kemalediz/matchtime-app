/**
 * SEVERAL DROPS AND SEVERAL JOINS AFTER THE TEAMS ARE OUT, through the
 * REAL analyze and dm-reply routes against a REAL database.
 *
 * ── THE INCIDENT: Sutton FC, 29 September 2026 ────────────────────────
 *
 * Teams published with 14 on the sheet. Then (UTC):
 *
 *   06:29  Elnur   OUT                          (self)
 *   06:55  Burak   OUT                          (admin)
 *   07:15  Abid    OUT                          (self)
 *   07:37  Youssef OUT, from the bench
 *   07:47  Mojib   IN                           → Burak's slot
 *   07:57  David   OUT, from the bench          (admin)
 *   07:57  Hamzah  IN, put in by Wasim          → Elnur's slot
 *   08:05  Ozgur   bench claim ("YES" by DM)
 *
 * Prod: the 07:57 re-declared sheet still named Abid on Red; at 08:05
 * Ozgur was announced "replacing Elnur" (whose slot Hamzah already held)
 * and seated on NO team; Abid's slot was never passed on.
 *
 * `src/lib/__tests__/team-slot-fill.test.ts` pins the rule and the
 * interleavings. This file pins what only the real stack can: the rows
 * that end up in Postgres, the words the group reads, and two claims
 * landing at the same instant under the real per-match lock.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimPlayerSpec } from "./group";
import { otherFacts, selfIn, selfOut } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

const IN = { route: "self_att", facts: selfIn() };
const OUT = { route: "self_att", facts: selfOut() };

const PLAYERS: SimPlayerSpec[] = [
  { key: "owner", name: "Kemal Owner", role: "OWNER" },
  { key: "wasim", name: "Wasim Akhtar", role: "ADMIN" },
  { key: "burak", name: "Burak Yildiz" },
  { key: "elnur", name: "Elnur Mammadov" },
  { key: "abid", name: "Abid Kazmi" },
  { key: "raihan", name: "Raihan Khan" },
  { key: "kieran", name: "Kieran Lowe" },
  { key: "mustafa", name: "Mustafa Cayir" },
  { key: "idris", name: "Idris Yildirim" },
  { key: "elvin", name: "Elvin Aliyev" },
  { key: "habib", name: "Habib Rahman" },
  { key: "najib", name: "Najib Ahmadi" },
  { key: "mauricio", name: "Mauricio Silva" },
  { key: "ibrahim", name: "Ibrahim Sahin" },
  { key: "youssef", name: "Youssef Amrani" },
  { key: "david", name: "David Brown" },
  { key: "ozgur", name: "Ozgur Tan" },
  { key: "mojib", name: "Mojib Sadat" },
  { key: "hamzah", name: "Hamzah Ali" },
];

/** Sheet order is insertion order (`id: asc`). Burak, Elnur and Abid are
 *  the first three Red lines, the order the vacancies are filled in. */
const RED = ["burak", "elnur", "abid", "owner", "wasim", "raihan", "kieran"];
const YELLOW = ["mustafa", "idris", "elvin", "habib", "najib", "mauricio", "ibrahim"];
const SHEET: Record<string, "RED" | "YELLOW"> = {
  ...Object.fromEntries(RED.map((k) => [k, "RED" as const])),
  ...Object.fromEntries(YELLOW.map((k) => [k, "YELLOW" as const])),
};

(LIVE ? test.describe.skip : test.describe)("several drops and joins after the teams are out (2026-09-29)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);

  const world = (
    request: Parameters<typeof createGroup>[0],
    db: Parameters<typeof createGroup>[1],
    bench: string[] = ["youssef", "david", "ozgur"],
  ) =>
    createGroup(request, db, {
      maxPlayers: 14,
      players: PLAYERS,
      upcomingMatch: { hoursFromNow: 14, deadlineHoursBeforeKickoff: 0 },
      attendance: [
        ...[...RED, ...YELLOW].map((key) => ({ key, status: "CONFIRMED" as const })),
        ...bench.map((key) => ({ key, status: "BENCH" as const })),
      ],
      teams: SHEET,
    });

  test("THE INCIDENT, replayed: Red 7, Yellow 7, nobody dropped on the sheet, each arrival in the slot it inherited", async ({
    request,
    db,
  }) => {
    const g = await world(request, db);

    await g.post("elnur", "out", OUT); // 06:29
    await g.post("owner", "@Match Time Burak is out", {
      tag: true,
      route: "other_att",
      facts: otherFacts("Burak", "out"),
    }); // 06:55
    await g.post("abid", "out", OUT); // 07:15
    await g.post("youssef", "out", OUT); // 07:37, from the bench
    for (const k of ["elnur", "burak", "abid", "youssef"]) {
      expect((await g.attendanceOf(k))?.status, k).toBe("DROPPED");
    }

    // 07:47: Mojib inherits the first vacancy on the sheet, Burak's.
    await g.post("mojib", "in", IN);
    expect((await g.attendanceOf("mojib"))?.status).toBe("CONFIRMED");
    expect((await g.teamSheet()).slice(0, 3).map((s) => s.key)).toEqual(["mojib", "elnur", "abid"]);

    // 07:57, one flush: David off the bench, Hamzah put in by Wasim.
    const at0757 = await g.postBatch([
      {
        player: "owner",
        body: "@Match Time David is out",
        tag: true,
        route: "other_att",
        facts: otherFacts("David", "out"),
      },
      { player: "wasim", body: "Hamzah in", route: "other_att", facts: otherFacts("Hamzah", "in") },
    ]);
    expect((await g.attendanceOf("hamzah"))?.status).toBe("CONFIRMED");
    expect((await g.teamSheet()).slice(0, 3).map((s) => s.key)).toEqual(["mojib", "hamzah", "abid"]);

    // The re-declared sheet names Hamzah in Elnur's place and shows
    // Abid's line as OPEN. On the day it still read "Abid Kazmi".
    const said = at0757.results.map((r) => r.reply ?? "").join("\n") + at0757.groupPosts.join("\n");
    expect(said).toContain("*Elnur is out*");
    expect(said).toContain("Hamzah Ali  (replacing Elnur)");
    expect(said).toContain("3. (open slot)");
    expect(said).not.toContain("Abid");

    // Refilled slots are no longer offered to the bench; Abid's still is.
    const offers = await g.openOffers();
    expect(offers.map((o) => o.replacingUserId)).toEqual([g.player("abid").userId]);

    // 08:05: Ozgur claims from the bench.
    const claim = await g.dm("ozgur", "YES");
    expect(claim.json.result).toBe("confirmed");
    const announce = claim.groupPosts.find((t) => t.includes("Ozgur Tan"));
    expect(announce, JSON.stringify(claim.groupPosts)).toBeTruthy();
    expect(announce).toContain("*Abid Kazmi*");
    expect(announce).toContain("*Red*");
    expect(announce).not.toContain("Elnur");

    // THE FINAL SHEET.
    const sheet = await g.teamSheet();
    const side = (team: string) => sheet.filter((s) => s.team === team).map((s) => s.key);
    expect(side("RED")).toEqual(["mojib", "hamzah", "ozgur", "owner", "wasim", "raihan", "kieran"]);
    expect(side("YELLOW")).toEqual(YELLOW);
    for (const s of sheet) {
      expect((await g.attendanceOf(s.key))?.status, s.key).toBe("CONFIRMED");
    }
    expect((await g.counts()).confirmed).toBe(14);
    expect(await g.openOffers()).toEqual([]);

    // The audit log names the slot actually inherited.
    const ev = await db.one<{ note: string | null }>(
      `SELECT note FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND cause = 'bench-claim'`,
      [g.matchId, g.player("ozgur").userId],
    );
    expect(ev?.note).toBe(`claimed the slot vacated by ${g.player("abid").userId}`);
  });

  test("join BEFORE drop, then a dropped player re-joins: nobody listed twice, no dropped name on the sheet", async ({
    request,
    db,
  }) => {
    const g = await world(request, db, []);
    // Mojib is CONFIRMED over a full sheet (an admin put him in as a
    // fifteenth): he has no slot, and there is none to take yet.
    await g.setAttendance("mojib", "CONFIRMED");
    expect((await g.teamSheet()).map((s) => s.key)).not.toContain("mojib");

    // Abid drops: the slot he vacates goes to the player already waiting.
    await g.post("abid", "out", OUT);
    expect((await g.teamSheet())[2]).toEqual({ key: "mojib", team: "RED" });

    // Abid changes his mind. His slot has been inherited, so he is not
    // put back on the sheet, and nobody is ever listed twice.
    await g.post("abid", "in", IN);
    const keys = (await g.teamSheet()).map((s) => s.key);
    expect(keys).not.toContain("abid");
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect((await g.attendanceOf(k))?.status, k).toBe("CONFIRMED");
  });

  test("two bench claims at the SAME instant each take a different slot", async ({ request, db }) => {
    const g = await world(request, db);
    await g.post("elnur", "out", OUT);
    await g.post("abid", "out", OUT);
    expect(await g.openOffers()).toHaveLength(2);

    const dm = (key: string) => {
      const p = g.player(key);
      return request.post("/api/whatsapp/dm-reply", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
        data: {
          phone: p.phone!.replace(/^\+/, ""),
          body: "YES",
          waMessageId: `sim-race-${key}-${Date.now()}`,
          authorName: p.name,
        },
      });
    };
    const [a, b] = await Promise.all([dm("youssef"), dm("david")]);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    await g.drainOutbound();

    expect((await g.attendanceOf("youssef"))?.status).toBe("CONFIRMED");
    expect((await g.attendanceOf("david"))?.status).toBe("CONFIRMED");
    const red = (await g.teamSheet()).filter((s) => s.team === "RED").map((s) => s.key);
    expect(red.slice(0, 3).sort()).toEqual(["burak", "david", "youssef"]);
    expect(red).not.toContain("elnur");
    expect(red).not.toContain("abid");
    expect(await g.openOffers()).toEqual([]);
  });

  test("a bench player's drop vacates no slot: the sheet does not move", async ({ request, db }) => {
    const g = await world(request, db);
    const before = await g.teamSheet();
    await g.post("david", "out", OUT);
    expect((await g.attendanceOf("david"))?.status).toBe("DROPPED");
    expect(await g.teamSheet()).toEqual(before);
    expect(await g.openOffers()).toEqual([]);
  });
});
