/**
 * UNNAMED-GUEST NAME ASK — deterministic half (routes + facts).
 *
 * WHY (production, 2026-08-31): Amir posted
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * and MatchTime said NOTHING. PR #26 had correctly stopped it registering
 * AMIR for that message, but `bring_guests_vague` was in ACTIONY_INTENTS,
 * so an untagged one was forced to noise. The club owner had to type
 * "yes pls, can you share the name?" himself before the guest could be
 * added, and asked for MatchTime to do the asking.
 *
 * The live-LLM half (`guest-name-ask-live.spec.ts`) proves the pipeline
 * CLASSIFIES these messages as unnamed-guest offers with realistic chat
 * history. This file proves the other half: what the SERVER does with
 * such facts — the copy, the four gates, and above all that the ask can
 * never move a single attendance row.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PORTED 2026-09-06 (§10 STEP 8) — AND ONE BRANCH GOT BETTER, NOT JUST
 * DIFFERENT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The old file fed `intent: "bring_guests_vague"` verdicts through
 * `setLlmStub` and asserted what `analyze/route.ts`'s ask branch did with
 * them. That branch was TERMINAL — it `continue`d before any apply path
 * — which is why half this file is about the ask NOT swallowing a write.
 *
 * There is no terminal branch now. `pipeline/engine.ts:471` collects the
 * unnamed claims into `guestAsks`, asks `shouldAskForGuestName` (the same
 * four gates, unchanged), pushes a `guest_name_ask` speech act — and then
 * carries straight on to the targets. So a message that both joins the
 * sender and offers an unnamed guest now does BOTH, where the shipped
 * behaviour was "the ask is lost, the write survives" and the header of
 * `guest-name-ask.ts` still calls that an acceptable cost. The two
 * swallowed-write cases below say so at their own sites.
 *
 * TWO CASES WERE DELETED, each with no successor input:
 *
 *   • "a DROP-shaped intent with a placeholder add still reaches its own
 *     handler". Its subject was the OUT SAFETY NET — `intent:
 *     "replacement_request"` with `registerAttendance: null`, where the
 *     net inferred the drop from `verdict.reasoning`. §10 step 6/8
 *     deleted that net; `src/lib/__tests__/seatbelt-deletion.test.ts`
 *     asserts it is gone AND that `reasoning` appears in no extractor
 *     schema, so the input cannot be produced. The behaviour it wanted —
 *     "someone replace me" really drops the sender — is now an ordinary
 *     `polarity: "out"` claim and is covered below by "…the sender's OUT
 *     is WRITTEN" and by `attendance-engine.spec.ts`'s S12 case.
 *
 *   • "a score reported alongside an unnamed guest offer is not
 *     discarded". A verdict could carry `scoreRed`/`scoreYellow` AND a
 *     guest offer at once; a message now takes exactly ONE route, so
 *     `score` and `offer` cannot both be true of it. THAT IS A REAL
 *     NARROWING and is recorded here rather than quietly dropped: a
 *     message that reports a result and offers a guest will now do one of
 *     the two, whichever the router picks. The within-route version of
 *     the same property — several claims plus a `sideRequests` entry,
 *     none of them lost — is `attendance-engine.spec.ts`'s "a message
 *     carrying several facts loses none of them".
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { claim, facts, otherFacts, selfIn, unnamedOther } from "../helpers/stub";

// ⚠️ 2026-10-31: the name ask is now an ORGANISER's only (friend link D1).
// A player's "my brother can play" gets a ✉️ and a friend link by DM; see
// e2e/sim/friend-link/. The senders below are organisers for that reason.
const ASK_RE = /what(?:'s| is| are) their names?\?/i;

test.describe("unnamed-guest name ask — server behaviour (routes + facts)", () => {
  test.beforeAll(resetDb);

  /** 5 confirmed of 14 — the real Sutton squad shape when the bug fired. */
  const mkGroup = (
    request: APIRequestContext,
    db: TestDb,
    opts: { confirmed?: number; maxPlayers?: number } = {},
  ) => {
    const roster = [
      { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
      // ORGANISERS since the friend link (2026-10-31, D1): a PLAYER's
      // unnamed or new guest gets a friend link instead of this ask
      // (e2e/sim/friend-link/issue.spec.ts); an organiser keeps it.
      { key: "amir", name: "Amir Ahmadi", role: "ADMIN" as const },
      { key: "pete", name: "Pete Power" },
      { key: "dan", name: "Dan Drummer" },
      { key: "felix", name: "Felix Fox" },
      { key: "greg", name: "Greg Gale" },
      { key: "henry", name: "Henry Hill" },
      { key: "ivan", name: "Ivan Ice" },
      { key: "jake", name: "Jake Jolly" },
      { key: "noah", name: "Noah North", role: "ADMIN" as const },
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

  /**
   * The facts an unnamed offer really carries. `personNamed: false` is
   * the single field that stops a ghost member being provisioned into a
   * paid squad (§4.1) and routes the claim to the ask instead.
   */
  const vague = (personRef = "my brother") => ({
    route: "offer",
    facts: unnamedOther(personRef),
  });

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

    const r = await grp.post("amir", "@Kemal Ediz my brother can play if needed", vague());

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

  test("each player gets their own ask, and no ask ever writes a row", async ({ request, db }) => {
    const grp = (await mkGroup(request, db)).attach(request);

    const first = await grp.post("amir", "my brother can play if needed", vague());
    expect(first.reply!).toMatch(ASK_RE);

    // A DIFFERENT player gets their own ask, addressed to them.
    const other = await grp.post("noah", "I can bring someone if you're short", vague("someone"));
    expect(other.reply!).toMatch(ASK_RE);
    expect(other.reply!).toContain("Noah");

    expect(await grp.attendanceOf("amir")).toBeNull();
    expect(await grp.attendanceOf("noah")).toBeNull();
  });

  /* ══════════════════════════════════════════════════════════════════
   * FIXED 2026-09-07. This was `test.fail()`, and the block that
   * documented the defect is deleted here as its own comment instructed.
   * ══════════════════════════════════════════════════════════════════
   *
   * WHAT WAS WRONG. `guest-name-ask.ts` promises ONE ask per player per
   * match, forever, keyed by a `SentNotification` row
   * (`guest-name-ask:<matchId>:<userId>`). `pipeline/load-state.ts:183`
   * READ those rows into `SquadState.guestAskedUserIds` and
   * `pipeline/engine.ts:481` passed them to `shouldAskForGuestName` as
   * `alreadyAsked` — and NOTHING WROTE THEM. The writer went with the
   * route's terminal ask branch in §10 step 8 and did not arrive
   * anywhere else, so `alreadyAsked` was permanently false and MatchTime
   * asked again on every unnamed offer the same player made.
   *
   * WHAT FIXED IT. `attendance-engine-batch.ts` CLAIMS the slot between
   * `decide()` and `compose()`, through an injected `claimGuestNameAsk`
   * dep (`owner-deps.ts`), and drops the `guest_name_ask` speech act
   * when the claim loses the race. That is the original PR #29 ordering
   * restored — claim before speaking, so a sent ask cannot fail to be
   * recorded — one layer down, beside the writes it now sits with.
   * ══════════════════════════════════════════════════════════════════ */
  test("asks ONCE per player per match, however many times they offer", async ({ request, db }) => {
    const grp = (await mkGroup(request, db)).attach(request);

    const first = await grp.post("amir", "my brother can play if needed", vague());
    expect(first.reply!).toMatch(ASK_RE);

    // THE ROW, not just the silence. The gate is a `SentNotification`
    // that `pipeline/load-state.ts` reads back on the next batch, and
    // for one day this assertion was the whole defect: the reader
    // existed, the decider existed, nothing wrote it. Asserting the
    // silence alone would pass again the moment a future change swapped
    // the dedupe for an in-memory one that does not survive the request.
    const rows = await db.all<{ key: string; kind: string; targetUser: string | null }>(
      `SELECT key, kind, "targetUser" FROM "SentNotification"
        WHERE kind = 'guest-name-ask' AND "matchId" = $1`,
      [grp.matchId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`guest-name-ask:${grp.matchId}:${grp.player("amir").userId}`);
    expect(rows[0].targetUser).toBe(grp.player("amir").userId);

    const second = await grp.post(
      "amir",
      "seriously, my mate could fill in if you're short",
      vague("my mate"),
    );
    expect(second.reply, "no nagging — MatchTime asked once and drops it").toBeNull();

    const third = await grp.post("amir", "@Match Time my brother can play if needed", {
      ...vague(),
      tag: true,
    });
    expect(third.reply, "not even when tagged — one ask, then silence").toBeNull();

    // Still ONE row after three offers: the ask that never happened
    // never claimed a slot either. Scoped to THIS match — the file
    // reseeds once, so other groups' rows share the table.
    const after = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "SentNotification"
        WHERE kind = 'guest-name-ask' AND "matchId" = $1`,
      [grp.matchId],
    );
    expect(after!.n).toBe("1");
  });

  test("…but a DIFFERENT match gets its own ask — the key is per match", async ({
    request,
    db,
  }) => {
    // "One ask per player per MATCH, forever" is two words, and the
    // second one is load-bearing: a player who offered a guest last
    // Tuesday must still be asked this Tuesday. The key carries the
    // match id and `load-state.ts` filters the rows by it, so this is
    // the assertion that stops a future "one ask per player" shortcut.
    const grp = (await mkGroup(request, db)).attach(request);

    const first = await grp.post("amir", "my brother can play if needed", vague());
    expect(first.reply!).toMatch(ASK_RE);

    // Last week is over; next week is the registration match now.
    await db.run(`UPDATE "Match" SET status = 'COMPLETED' WHERE id = $1`, [grp.matchId]);
    await grp.addMatch({ daysFromNow: 9 });

    const nextWeek = await grp.post("amir", "my brother can play if needed", vague());
    expect(nextWeek.reply, "a new match is a new ask").toMatch(ASK_RE);

    const rows = await db.all<{ key: string }>(
      `SELECT n.key FROM "SentNotification" n
         JOIN "Match" m ON m.id = n."matchId"
        WHERE n.kind = 'guest-name-ask' AND m."activityId" = $1
        ORDER BY n.key`,
      [grp.activityId],
    );
    expect(rows, "one row per match, both of them Amir's").toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size, "two DIFFERENT keys").toBe(2);
  });

  // ── Squad full ──────────────────────────────────────────────────────

  test("untagged offer on a FULL squad → silence (no slot to offer a guest)", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db, { maxPlayers: 6, confirmed: 6 });
    const r = await grp.post("amir", "my brother can play if needed", vague());
    expect(r.reply, "asking for a name we cannot seat is worse than silence").toBeNull();
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  test("TAGGED offer on a FULL squad → still answered (they addressed MatchTime)", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db, { maxPlayers: 6, confirmed: 6 });
    const r = await grp.post("amir", "@Match Time can I bring someone?", {
      ...vague("someone"),
      tag: true,
    });
    expect(r.reply!).toMatch(ASK_RE);
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  // ── Banter must stay silent ─────────────────────────────────────────

  test("banter that merely mentions a mate → silence: the extractor reads no offer (2026-10-30)", async ({
    request,
    db,
  }) => {
    // Until 2026-10-30 a word test (`looksLikeUnnamedGuestOffer`) also had
    // to find an offer in the TEXT. "No string parsing": whether a mate is
    // offered is the extractor's reading. Read correctly, banter carries
    // no claim, so nothing is asked, even with the router's offer slip.
    const grp = (await mkGroup(request, db)).attach(request);
    for (const body of [
      "my brother watched the game last night lol",
      "my mate says the pitch is waterlogged",
    ]) {
      const r = await grp.post("amir", body, { route: "offer", facts: { claims: [], affirmation: "none", sideRequests: [] } });
      expect(r.reply, `MatchTime must stay quiet on: ${body}`).toBeNull();
    }
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  // ── A NAMED guest still works, untouched ────────────────────────────

  test("a NAMED guest is registered as before, with no name-ask", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "my brother Shahrokh can play", {
      route: "other_att",
      facts: otherFacts("Shahrokh", "in"),
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

  // ── The ghost-user shape: a placeholder wearing personNamed: true ────
  //
  // MDs/analyzer-redesign-2026-08-31.md §4.1: with the pre-incident squad
  // state the analyzer emitted registerFor:[{name:"Amir's brother"}] on
  // SIX of six runs. That provisions a User literally called "Amir's
  // brother" into a paid squad.

  test("a personRef of \"Amir's brother\", read as unnamed, provisions no ghost: it becomes the name-ask", async ({
    request,
    db,
  }) => {
    // `personNamed: false`: the extractor's reading of a relationship
    // (2026-10-30). The word list in `identity.ts` that also re-checked a
    // model's `personNamed: true` is gone ("no string parsing"); the
    // prompt names relationships and the whole group as unnamed.
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "my brother can play if needed", {
      route: "other_att",
      facts: unnamedOther("Amir's brother"),
    });
    const ghost = await grp.db.one<{ id: string }>(
      `SELECT u.id FROM "User" u WHERE u.name ILIKE $1`,
      ["%brother%"],
    );
    expect(ghost, "no member called \"Amir's brother\" may be created").toBeNull();
    expect(r.reply!).toMatch(ASK_RE);
    expect(await grp.attendanceOf("amir")).toBeNull();
  });

  test("a mixed claim set keeps the real name and asks about the placeholder", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "my brother Shahrokh and another mate can play", {
      tag: true,
      route: "other_att",
      facts: facts([
        claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "in" }),
        claim({ subject: "other", personRef: "my brother", personNamed: false, polarity: "in" }),
      ]),
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
  // The ask branch used to be TERMINAL: it `continue`d before any apply
  // path, so a verdict that reached it had its WHOLE payload discarded.
  // A message carrying the sender's OWN attendance AND an unnamed guest
  // therefore had to be kept away from it. The player believed they were
  // in the squad, the DB said otherwise, and the pre-match reminder reads
  // the DB.
  //
  // The engine has no terminal branch: `guestAsks` is a speech act and
  // `targets` is a write, and both are produced from the same claim list
  // in the same pass. So the two cases below now assert the STRONGER
  // thing — the write lands AND the ask is free to fire — rather than
  // "the ask was successfully avoided".

  test("\"I'm in, and my brother can play too\" → the sender's IN is WRITTEN", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "I'm in, and my brother can play too", {
      route: "self_att",
      facts: facts([
        claim(),
        claim({ subject: "other", personRef: "my brother", personNamed: false, polarity: "in" }),
      ]),
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "the sender's own IN must never be swallowed by the name-ask",
    ).toBe("CONFIRMED");
    // The placeholder is still not provisioned, so no ghost exists.
    const ghost = await grp.db.one<{ id: string }>(`SELECT u.id FROM "User" u WHERE u.name ILIKE $1`, [
      "%brother%",
    ]);
    expect(ghost, "and still no ghost member").toBeNull();
    // AND the ask survives the combined message, which is the half the
    // terminal branch could not do. `guest-name-ask.ts`'s header calls
    // losing it "an acceptable cost"; it is no longer a cost that has to
    // be paid.
    expect(r.reply ?? "", "the guest is still asked about").toMatch(ASK_RE);
  });

  test("\"can't make it but my mate can play\" → the sender's OUT is WRITTEN", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    await grp.post("amir", "can't make it tonight but my mate can play", {
      route: "self_att",
      facts: facts([
        claim({ polarity: "out" }),
        claim({ subject: "other", personRef: "my mate", personNamed: false, polarity: "in" }),
      ]),
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "a player who typed OUT must never stay counted as playing",
    ).toBe("DROPPED");
  });

  test("\"someone replace me, my mate could fill in\" drops the sender", async ({
    request,
    db,
  }) => {
    // THE S12 SHAPE, and the reason the old "DROP-shaped intent" case
    // could be deleted rather than merely renamed. It used to depend on
    // the OUT safety net reading `verdict.reasoning` for a drop signal,
    // because `replacement_request` carried the drop nowhere else. The
    // drop is a claim now, and the ask for cover is a `sideRequests`
    // entry beside it, so nothing has to be inferred from prose.
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    const r = await grp.post("amir", "someone replace me, my mate could fill in", {
      route: "self_att",
      facts: facts(
        [
          claim({ polarity: "out" }),
          claim({ subject: "other", personRef: "my mate", personNamed: false, polarity: "in" }),
        ],
        { sideRequests: ["recruit"] },
      ),
    });
    expect(
      (await grp.attendanceOf("amir"))?.status,
      "the sender asked to be replaced, so the sender is out",
    ).toBe("DROPPED");
    expect(r.reply ?? "").not.toMatch(/already full|no open spots/i);
  });

  // ── Controls: the rest of the contract is untouched ──────────────────

  test("a genuine SELF standing offer still registers the sender, no name-ask", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "I'll be the 14th if you're short", {
      route: "offer",
      facts: selfIn({ contingent: true, conditionOn: "squad", tense: "future" }),
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
    expect(r.reply ?? "").not.toMatch(ASK_RE);
  });

  test("a plain untagged IN is unaffected", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "in", { route: "self_att", facts: selfIn() });
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
    const r = await grp.post("amir", "my brother can play if needed", vague());
    expect(r.reply).toBeNull();
  });
});
