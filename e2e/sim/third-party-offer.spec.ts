/**
 * THIRD-PARTY OFFER — deterministic half (stubbed verdicts).
 *
 * The live-LLM half lives in `third-party-offer-live.spec.ts` and proves
 * the analyzer no longer CLASSIFIES "my brother can play if needed" as
 * the sender's own standing offer. This file proves the other half: that
 * when the model DOES slip and emits the verdict production actually got
 *
 *     {intent: "conditional_in", registerAttendance: "BENCH",
 *      reasoning: "Standing-offer conditional …"}
 *
 * on a message whose subject is somebody else, the SERVER refuses to
 * write the sender's row. That is the seatbelt in
 * `offerIsAboutSomeoneElse` + the analyze route, and it needs a stub to
 * exercise because the whole point is a verdict the model should never
 * produce again.
 *
 * The verdict below is copied from the real AnalyzedMessage row for
 * waMessageId of Amir's 30/08 23:03 message.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

test.describe("third-party offer — server seatbelt (stubbed verdicts)", () => {
  test.beforeAll(resetDb);

  const mkGroup = (request: APIRequestContext, db: TestDb) =>
    createGroup(request, db, {
      maxPlayers: 14,
      players: [
        { key: "owner", name: "Oscar Owner", role: "OWNER" },
        { key: "amir", name: "Amir Ahmadi" },
        { key: "pete", name: "Pete Power" },
        { key: "dan", name: "Dan Drummer" },
        { key: "felix", name: "Felix Fox" },
      ],
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
      ],
    });

  const attendanceByName = (grp: SimGroup, name: string) =>
    grp.db.one<{ status: string }>(
      `SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
       WHERE a."matchId" = $1 AND u.name ILIKE $2`,
      [grp.matchId, `%${name}%`],
    );

  // ── The production verdict, replayed verbatim ────────────────────────

  test("the exact production verdict no longer benches the sender", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "@Kemal Ediz my brother can play if needed", {
      verdict: {
        intent: "conditional_in",
        registerAttendance: "BENCH",
        react: "👍",
        confidence: 0.95,
        reply: "Thanks Amir — putting you on the bench. If we drop below 14, you're first up 🙏",
        reasoning:
          "Standing-offer conditional - 'my brother can play if needed' is contingent on squad state (being short). Slotting on bench per the standing-offer rules.",
      },
    });

    expect(await grp.attendanceOf("amir"), "Amir must not be written anywhere").toBeNull();
    expect(await grp.bench(), "the bench must stay empty").toEqual([]);
    // The model's reply ("putting you on the bench") is now false — the
    // bot must not post it, and must not react as if it registered him.
    expect(r.reply).toBeNull();
    expect(r.react).toBeNull();
    expect(r.groupPosts).toEqual([]);
  });

  test("a stray self IN on a third-party-subject message is stripped too", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "my mate could fill in if you're short", {
      verdict: {
        intent: "in",
        registerAttendance: "IN",
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: model wrongly self-registers the sender",
      },
    });
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  // ── The seatbelt must not eat the working paths ──────────────────────

  test("a NAMED guest is still registered; only the sender's own row is dropped", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "my brother Shahrokh can play", {
      verdict: {
        intent: "in",
        // The slip: the model adds Shahrokh AND self-registers Amir.
        registerAttendance: "IN",
        registerFor: [{ name: "Shahrokh", action: "IN" }],
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: named guest add plus a wrong self write",
      },
      tag: true,
    });
    const guest = await attendanceByName(grp, "Shahrokh");
    expect(guest, "Shahrokh must still be registered").not.toBeNull();
    expect(await grp.attendanceOf("amir"), "Amir must not be").toBeNull();
  });

  test("a MIXED offer that includes the sender is untouched", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "me and my brother are both in", {
      verdict: {
        intent: "in",
        registerAttendance: "IN",
        react: "✅",
        confidence: 0.95,
        reasoning: "stub: sender explicitly included",
      },
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
  });

  test("a genuine self standing offer still registers the SENDER", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "I'll be the 14th if you're short", {
      verdict: {
        intent: "conditional_in",
        registerAttendance: "BENCH",
        react: "👍",
        confidence: 0.95,
        reply: "Thanks Amir — putting you on the bench 🙏",
        reasoning: "stub: standing offer about the sender",
      },
    });
    // The seatbelt must not strip a GENUINE self offer — the sender still
    // gets a self-attendance row. That is what this control exists to pin,
    // and it is unchanged.
    //
    // The row's STATUS is capacity's business, not the classifier's (see
    // BenchIntent in src/lib/attendance.ts, 2026-08-31). This squad is 3/14,
    // so the offer's own condition ("if you're short") is already met and a
    // bench alongside 11 open slots is exactly the state that produced the
    // "Confirmed (10/14) + Bench (1): Amir" roster. On a FULL squad the same
    // verdict still benches — see e2e/sim/bench-capacity.spec.ts.
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
  });

  test("a third-party-subject OUT is left alone (never strip a drop)", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    await grp.post("amir", "my son is ill so cant make it tonight", {
      verdict: {
        intent: "out",
        registerAttendance: "OUT",
        react: "👋",
        confidence: 0.95,
        reasoning: "stub: a real drop that happens to open with a family member",
      },
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("DROPPED");
  });
});
