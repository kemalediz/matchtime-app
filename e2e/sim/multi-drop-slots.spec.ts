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
import { addMatchAvailabilityBodies, otherFacts, selfIn, selfOut } from "../helpers/stub";
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

  test("THE INCIDENT's joins, replayed with no bench: each arrival in the slot it inherited", async ({
    request,
    db,
  }) => {
    // Since 2026-11-17 a bench moves up the moment a place opens
    // (`bench-fill.ts`), so the day's bench is replayed in the next test;
    // this one keeps the joins: Mojib and Hamzah, with nobody waiting.
    const g = await world(request, db, []);

    await g.post("elnur", "out", OUT); // 06:29
    await g.post("owner", "@Match Time Burak is out", {
      tag: true,
      route: "other_att",
      facts: otherFacts("Burak", "out"),
    }); // 06:55
    await g.post("abid", "out", OUT); // 07:15
    for (const k of ["elnur", "burak", "abid"]) {
      expect((await g.attendanceOf(k))?.status, k).toBe("DROPPED");
    }

    // 07:47: Mojib inherits the first vacancy on the sheet, Burak's.
    await g.post("mojib", "in", IN);
    expect((await g.attendanceOf("mojib"))?.status).toBe("CONFIRMED");
    expect((await g.teamSheet()).slice(0, 3).map((s) => s.key)).toEqual(["mojib", "elnur", "abid"]);

    // 07:57: Hamzah put in by Wasim.
    const at0757 = await g.postBatch([
      { player: "wasim", body: "Hamzah in", route: "other_att", facts: otherFacts("Hamzah", "in") },
    ]);
    expect((await g.attendanceOf("hamzah"))?.status).toBe("CONFIRMED");
    expect((await g.teamSheet()).slice(0, 3).map((s) => s.key)).toEqual(["mojib", "hamzah", "abid"]);

    // The re-declared sheet names Hamzah in Elnur's place and shows
    // Abid's line as OPEN. On the day it still read "Abid Kazmi".
    const said = at0757.results.map((r) => r.reply ?? "").join("\n") + at0757.groupPosts.join("\n");
    expect(said).toContain("Hamzah Ali  (replacing Elnur)");
    expect(said).toContain("3. (open slot)");
    expect(said).not.toContain("Abid");
    expect(await g.openOffers()).toEqual([]);
  });

  test("THE INCIDENT's bench, since 2026-11-17: each drop moves the next one up into the slot it vacated", async ({
    request,
    db,
  }) => {
    const g = await world(request, db);

    await g.post("elnur", "out", OUT);
    // Youssef was first on the bench: Elnur's slot is his, at once.
    expect((await g.attendanceOf("youssef"))?.status).toBe("CONFIRMED");
    await g.post("owner", "@Match Time Burak is out", { tag: true, route: "other_att", facts: otherFacts("Burak", "out") });
    expect((await g.attendanceOf("david"))?.status).toBe("CONFIRMED");
    const at0715 = await g.post("abid", "out", OUT);
    expect((await g.attendanceOf("ozgur"))?.status).toBe("CONFIRMED");

    // Ozgur is told he took ABID's place on Red: the slot really inherited.
    const line = at0715.groupPosts.find((t) => t.includes("Ozgur Tan"));
    expect(line, JSON.stringify(at0715.groupPosts)).toBeTruthy();
    expect(line).toContain("takes *Abid Kazmi*'s place on *Red*");

    // THE FINAL SHEET: every slot held by somebody playing, nobody dropped on it.
    const sheet = await g.teamSheet();
    const side = (team: string) => sheet.filter((s) => s.team === team).map((s) => s.key);
    expect(side("RED")).toEqual(["david", "youssef", "ozgur", "owner", "wasim", "raihan", "kieran"]);
    expect(side("YELLOW")).toEqual(YELLOW);
    for (const s of sheet) {
      expect((await g.attendanceOf(s.key))?.status, s.key).toBe("CONFIRMED");
    }
    expect(await g.counts()).toMatchObject({ confirmed: 14, bench: 0 });
    expect(await g.openOffers()).toEqual([]);

    // The audit log records the move and why.
    const ev = await db.one<{ note: string | null }>(
      `SELECT note FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND cause = 'bench-moved-up'`,
      [g.matchId, g.player("ozgur").userId],
    );
    expect(ev?.note).toBe(`first on the bench, moved up into the place ${g.player("abid").userId} left`);
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
    // A claim answers an OFFER, which since 2026-11-17 only an
    // organiser-pick club's fallback opens. That club, its two offers.
    const g = await world(request, db);
    await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'organiser' WHERE id = $1`, [g.orgId]);
    await g.post("elnur", "out", OUT);
    await g.post("abid", "out", OUT);
    for (const k of ["elnur", "abid"]) {
      await db.run(
        `INSERT INTO "BenchSlotOffer" (id, "matchId", "replacingUserId", "createdAt", "updatedAt") VALUES ($1, $2, $3, now(), now())`,
        [`sim-race-offer-${k}-${g.matchId}`, g.matchId, g.player(k).userId],
      );
    }
    expect(await g.openOffers()).toHaveLength(2);

    addMatchAvailabilityBodies({ YES: "in" });
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
