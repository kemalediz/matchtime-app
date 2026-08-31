/**
 * UNNAMED-GUEST NAME ASK — deterministic half (stubbed verdicts).
 *
 * WHY (production, 2026-08-31): Amir posted
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * and MatchTime said NOTHING. PR #26 had correctly stopped it registering
 * AMIR for that message, but `bring_guests_vague` is in ACTIONY_INTENTS,
 * so an untagged one is forced to noise. The club owner had to type
 * "yes pls, can you share the name?" himself before the guest could be
 * added, and asked for MatchTime to do the asking.
 *
 * The live-LLM half (`guest-name-ask-live.spec.ts`) proves the analyzer
 * CLASSIFIES these messages as unnamed-guest offers with realistic chat
 * history. This file proves the other half: what the SERVER does with
 * such a verdict — the copy, the gates, and above all that the ask can
 * never move a single attendance row.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const ASK_RE = /what(?:'s| is| are) their names?\?/i;

test.describe("unnamed-guest name ask — server behaviour (stubbed verdicts)", () => {
  test.beforeAll(resetDb);

  /** 8 confirmed of 14 — the real Sutton squad state when the bug fired. */
  const mkGroup = (
    request: APIRequestContext,
    db: TestDb,
    opts: { confirmed?: number; maxPlayers?: number } = {},
  ) => {
    const roster = [
      { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
      { key: "amir", name: "Amir Ahmadi" },
      { key: "pete", name: "Pete Power" },
      { key: "dan", name: "Dan Drummer" },
      { key: "felix", name: "Felix Fox" },
      { key: "greg", name: "Greg Gale" },
      { key: "henry", name: "Henry Hill" },
      { key: "ivan", name: "Ivan Ice" },
      { key: "jake", name: "Jake Jolly" },
      { key: "noah", name: "Noah North" },
      { key: "quinn", name: "Quinn Quick" },
    ];
    const fillers = roster
      .filter((p) => p.key !== "amir")
      .slice(0, opts.confirmed ?? 5)
      .map((p) => ({ key: p.key, status: "CONFIRMED" as const }));
    return createGroup(request, db, {
      maxPlayers: opts.maxPlayers ?? 14,
      players: roster,
      attendance: fillers,
    });
  };

  /** The verdict the prompt asks for on an unnamed offer. */
  const VAGUE = {
    intent: "bring_guests_vague",
    registerAttendance: null,
    react: null,
    reply: "thanks @Amir, could you share their names so I can add them to the list? 🙌",
    confidence: 0.9,
    reasoning: "stub: unnamed third-party offer",
  };

  const rowCount = (grp: SimGroup) =>
    grp.db.one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "Attendance" WHERE "matchId" = $1`, [
      grp.matchId,
    ]);

  // ── The production message, untagged, squad short ────────────────────

  test("untagged unnamed offer while short → MatchTime asks for the name, writes nothing", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const before = (await rowCount(grp))!.n;

    const r = await grp.post("amir", "@Kemal Ediz my brother can play if needed", {
      verdict: VAGUE,
    });

    expect(r.reply, "MatchTime must speak").not.toBeNull();
    expect(r.reply!).toMatch(ASK_RE);
    expect(r.reply!).toContain("Amir");
    // House style.
    expect(r.reply!).not.toContain("—");
    expect(r.reply!).not.toContain("/");

    // NOT ONE ROW MOVED — not for the sender, not for a ghost guest.
    expect(await grp.attendanceOf("amir"), "the sender must never be registered").toBeNull();
    expect(await grp.bench(), "the bench must stay empty").toEqual([]);
    expect((await rowCount(grp))!.n, "no attendance row created or changed").toBe(before);
    expect(r.groupPosts, "the ask is a reply, not a broadcast").toEqual([]);
  });

  // ── Idempotent: exactly one ask per player per match ─────────────────

  test("asks ONCE per player per match, however many times they offer", async ({ request, db }) => {
    const grp = (await mkGroup(request, db)).attach(request);

    const first = await grp.post("amir", "my brother can play if needed", { verdict: VAGUE });
    expect(first.reply!).toMatch(ASK_RE);

    const second = await grp.post("amir", "seriously, my mate could fill in if you're short", {
      verdict: VAGUE,
    });
    expect(second.reply, "no nagging — MatchTime asked once and drops it").toBeNull();

    const third = await grp.post("amir", "@Match Time my brother can play if needed", {
      verdict: VAGUE,
      tag: true,
    });
    expect(third.reply, "not even when tagged — one ask, then silence").toBeNull();

    // A DIFFERENT player still gets their own ask.
    const other = await grp.post("noah", "I can bring someone if you're short", { verdict: VAGUE });
    expect(other.reply!).toMatch(ASK_RE);
    expect(other.reply!).toContain("Noah");

    expect(await grp.attendanceOf("amir")).toBeNull();
    expect(await grp.attendanceOf("noah")).toBeNull();
  });

  // ── Squad full ──────────────────────────────────────────────────────

  test("untagged offer on a FULL squad → silence (no slot to offer a guest)", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db, { maxPlayers: 6, confirmed: 6 });
    const r = await grp.post("amir", "my brother can play if needed", { verdict: VAGUE });
    expect(r.reply, "asking for a name we cannot seat is worse than silence").toBeNull();
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  test("TAGGED offer on a FULL squad → still answered (they addressed MatchTime)", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db, { maxPlayers: 6, confirmed: 6 });
    const r = await grp.post("amir", "@Match Time can I bring someone?", {
      verdict: VAGUE,
      tag: true,
    });
    expect(r.reply!).toMatch(ASK_RE);
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  // ── Banter must stay silent ─────────────────────────────────────────

  test("banter that merely mentions a mate → silence, even if the model slips", async ({
    request,
    db,
  }) => {
    const grp = (await mkGroup(request, db)).attach(request);
    for (const body of [
      "my brother watched the game last night lol",
      "my mate says the pitch is waterlogged",
    ]) {
      const r = await grp.post("amir", body, { verdict: VAGUE });
      expect(r.reply, `MatchTime must stay quiet on: ${body}`).toBeNull();
    }
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  // ── A NAMED guest still works, untouched ────────────────────────────

  test("a NAMED guest is registered as before, with no name-ask", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "my brother Shahrokh can play", {
      verdict: {
        intent: "in",
        registerAttendance: null,
        registerFor: [{ name: "Shahrokh", action: "IN" }],
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: named guest add",
      },
    });
    const guest = await grp.db.one<{ status: string }>(
      `SELECT a.status FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
       WHERE a."matchId" = $1 AND u.name ILIKE $2`,
      [grp.matchId, "%Shahrokh%"],
    );
    expect(guest, "Shahrokh must still be registered").not.toBeNull();
    expect(await grp.attendanceOf("amir"), "and the sender must not be").toBeNull();
    expect(r.reply ?? "", "no name-ask when a name was given").not.toMatch(ASK_RE);
  });

  // ── The ghost-user verdict: registerFor with a placeholder name ──────
  //
  // MDs/analyzer-redesign-2026-08-31.md §4.1: with the pre-incident squad
  // state the analyzer emitted registerFor:[{name:"Amir's brother"}] on
  // SIX of six runs. That provisions a User literally called "Amir's
  // brother" into a paid squad.

  test("registerFor \"Amir's brother\" provisions no ghost — it becomes the name-ask", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "my brother can play if needed", {
      verdict: {
        intent: "in",
        registerAttendance: null,
        registerFor: [{ name: "Amir's brother", action: "IN" }],
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: the 6-of-6 ghost-user verdict",
      },
    });
    const ghost = await grp.db.one<{ id: string }>(
      `SELECT u.id FROM "User" u WHERE u.name ILIKE $1`,
      ["%brother%"],
    );
    expect(ghost, "no member called \"Amir's brother\" may be created").toBeNull();
    expect(r.reply!).toMatch(ASK_RE);
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  test("a mixed registerFor keeps the real name and drops the placeholder", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "my brother Shahrokh and another mate can play", {
      verdict: {
        intent: "in",
        registerAttendance: null,
        registerFor: [
          { name: "Shahrokh", action: "IN" },
          { name: "my brother", action: "IN" },
        ],
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: one real name, one placeholder",
      },
      tag: true,
    });
    const real = await grp.db.one<{ id: string }>(`SELECT u.id FROM "User" u WHERE u.name ILIKE $1`, [
      "%Shahrokh%",
    ]);
    const ghost = await grp.db.one<{ id: string }>(`SELECT u.id FROM "User" u WHERE u.name ILIKE $1`, [
      "%my brother%",
    ]);
    expect(real, "the real name is still registered").not.toBeNull();
    expect(ghost, "the placeholder never becomes a member").toBeNull();
  });

  // ── THE SWALLOWED-WRITE DEFECT (PR #29 review) ──────────────────────
  //
  // The ask branch is TERMINAL: it `continue`s before any apply path. So
  // a verdict that reaches it has its WHOLE payload discarded, not just
  // its registerFor. A message carrying the sender's OWN attendance AND
  // an unnamed guest must therefore never reach it. The player believes
  // they are in the squad, the DB says otherwise, and the pre-match
  // reminder reads the DB.

  test("\"I'm in, and my brother can play too\" → the sender's IN is WRITTEN", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "I'm in, and my brother can play too", {
      verdict: {
        intent: "in",
        registerAttendance: "IN",
        registerFor: [{ name: "my brother", action: "IN" }],
        react: "✅",
        confidence: 0.9,
        reasoning: "stub: sender joins AND offers an unnamed guest",
      },
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "the sender's own IN must never be swallowed by the name-ask",
    ).toBe("CONFIRMED");
    // The placeholder is still stripped, so no ghost is provisioned.
    const ghost = await grp.db.one<{ id: string }>(`SELECT u.id FROM "User" u WHERE u.name ILIKE $1`, [
      "%brother%",
    ]);
    expect(ghost, "and still no ghost member").toBeNull();
    // Losing the name-ask on a combined message is the accepted cost.
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  test("\"can't make it but my mate can play\" → the sender's OUT is WRITTEN", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    await grp.post("amir", "can't make it tonight but my mate can play", {
      verdict: {
        intent: "out",
        registerAttendance: "OUT",
        registerFor: [{ name: "my mate", action: "IN" }],
        react: "👋",
        confidence: 0.9,
        reasoning: "stub: sender drops AND offers an unnamed guest",
      },
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "a player who typed OUT must never stay counted as playing",
    ).toBe("DROPPED");
  });

  test("a DROP-shaped intent with a placeholder add still reaches its own handler", async ({
    request,
    db,
  }) => {
    // intent "replacement_request" with registerAttendance null is the
    // shape the route's OUT safety net exists for. The terminal ask
    // branch must not intercept it.
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    const r = await grp.post("amir", "someone replace me, my mate could fill in", {
      verdict: {
        intent: "replacement_request",
        registerAttendance: null,
        registerFor: [{ name: "my mate", action: "IN" }],
        react: "👋",
        confidence: 0.9,
        reasoning: "sender is a definite drop; needs a replacement",
      },
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "the OUT safety net must still be reachable",
    ).toBe("DROPPED");
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  test("a score reported alongside an unnamed guest offer is not discarded", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "we won 5-2 by the way, and my brother can play next week", {
      verdict: {
        intent: "bring_guests_vague",
        registerAttendance: null,
        scoreRed: 5,
        scoreYellow: 2,
        react: null,
        confidence: 0.9,
        reasoning: "stub: a score rides along with the guest offer",
      },
    });
    // Whatever the score path decides, the name-ask must not have
    // swallowed the verdict before it got there.
    expect(r.intent, "the verdict must not be reduced to the name-ask").not.toBe(
      "bring_guests_vague",
    );
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  // ── Controls: the rest of the contract is untouched ──────────────────

  test("a genuine SELF standing offer still registers the sender, no name-ask", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "I'll be the 14th if you're short", {
      verdict: {
        intent: "conditional_in",
        registerAttendance: "BENCH",
        react: "👍",
        confidence: 0.95,
        reasoning: "stub: standing offer about the sender",
      },
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  test("a plain untagged IN is unaffected", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "in");
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  test("an org with attendance OFF never asks", async ({ request, db }) => {
    const grp = await createGroup(request, db, {
      maxPlayers: 14,
      features: { attendance: false },
      players: [
        { key: "owner", name: "Oscar Owner", role: "OWNER" },
        { key: "amir", name: "Amir Ahmadi" },
      ],
    });
    const r = await grp.post("amir", "my brother can play if needed", { verdict: VAGUE });
    expect(r.reply).toBeNull();
  });
});
