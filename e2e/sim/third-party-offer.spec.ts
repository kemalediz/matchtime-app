/**
 * THIRD-PARTY OFFER — the sender is not the subject.
 *
 * The live-LLM half (`third-party-offer-live.spec.ts`) proves the real
 * model does not read "my brother can play if needed" as the SENDER's
 * own standing offer. This file proves the other half, deterministically:
 * that when the pipeline is told the claim is about somebody else, no
 * row is ever written for the person who typed it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PORTED 2026-09-06 (§10 STEP 8) — AND THE MECHANISM UNDER TEST CHANGED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT IT USED TO BE. `setLlmStub` fed the route the verdict production
 * actually got on Amir's 30/08 23:03 message —
 *
 *     {intent: "conditional_in", registerAttendance: "BENCH",
 *      reasoning: "Standing-offer conditional …"}
 *
 * — a decision that was already wrong, and asserted that a SEATBELT in
 * `analyze/route.ts` (`offerIsAboutSomeoneElse`, a regex over the body)
 * refused to execute it.
 *
 * WHY THAT SEATBELT IS GONE. `route.ts:141` is now its tombstone:
 * *"offerIsAboutSomeoneElse → `subject`, a field rather than an
 * inference"*. The extractor reports WHO each claim is about, one claim
 * at a time; a claim about the sender and a claim about a brother are
 * two different objects, so there is no longer a single message-level
 * decision for a regex to overrule. `interaction-contract.ts` still
 * exports the function and `__tests__/interaction-contract.test.ts`
 * still pins its patterns, but nothing on the write path calls it.
 *
 * WHAT THAT MEANS FOR THIS FILE. The PROPERTY survives and is what every
 * case below still asserts: a message whose claims are about someone
 * else never moves the sender's row. The MECHANISM moved from a
 * post-hoc strip to the shape of the facts, so the cases are expressed
 * as facts.
 *
 * ONE CASE WAS DELETED — "a stray self IN on a third-party-subject
 * message is stripped too". It fed `registerAttendance: "IN"` on a
 * message about a brother and asserted the strip fired anyway. There is
 * no input that produces it now: `registerAttendance` had no subject,
 * which is exactly why a strip was needed; a `Claim` cannot be about the
 * sender and about somebody else at once. Testing it would mean
 * asserting that a deleted guard fires on input nothing can produce.
 * The half of it that is still real — an unnamed third party provisions
 * no ghost member — is `e2e/sim/attendance-engine.spec.ts`'s "an unnamed
 * third party provisions no ghost member — the A5 incident", and the
 * ask it produces is `e2e/sim/guest-name-ask.spec.ts`.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { claim, facts, otherFacts, selfIn, selfOut, unnamedOther } from "../helpers/stub";

test.describe("third-party offer — the sender is not the subject", () => {
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

  // ── The production message, replayed ────────────────────────────────

  test("the production message writes no row for the sender, and no ghost for the brother", async ({
    request,
    db,
  }) => {
    const grp = await mkGroup(request, db);
    const r = await grp.post("amir", "@Kemal Ediz my brother can play if needed", {
      route: "offer",
      facts: unnamedOther("my brother"),
    });

    expect(await grp.attendanceOf("amir"), "Amir must not be written anywhere").toBeNull();
    expect(await grp.bench(), "the bench must stay empty").toEqual([]);
    expect(await attendanceByName(grp, "brother"), "no ghost guest is registered").toBeNull();
    expect(r.groupPosts).toEqual([]);

    // ── WHAT CHANGED, TWICE ─────────────────────────────────────────
    // Until 2026-10-31 the same facts reached `guest-name-ask.ts` and
    // MatchTime asked "what's their name?". Since the friend link (Kemal,
    // 2026-10-31) a PLAYER's friend gets a personal link by DM instead,
    // and the message a ✉️: the friend joins only through his own details
    // and WhatsApp code. The row is still untouched, which is the property
    // this file is about. `e2e/sim/friend-link/` owns the link.
    expect(r.reply, "nothing is said in the group").toBeNull();
    expect(r.react, "✉️: a link went to him by DM").toBe("✉️");
    expect(r.dms.map((d) => d.text).join("\n")).toMatch(/link for your friend/);
  });

  // ── The property must not eat the working paths ──────────────────────

  test("a NAMED guest from an organiser is registered; the sender still gets no row", async ({ request, db }) => {
    // An organiser (2026-10-31): a player's named newcomer gets a friend link.
    const grp = await mkGroup(request, db);
    await grp.post("owner", "my brother Shahrokh can play", {
      tag: true,
      route: "other_att",
      facts: otherFacts("Shahrokh", "in"),
    });
    const guest = await attendanceByName(grp, "Shahrokh");
    expect(guest, "Shahrokh must still be registered").not.toBeNull();
    expect(await grp.attendanceOf("owner"), "the owner must not be moved").toMatchObject({ status: "CONFIRMED" });
  });

  test("a MIXED offer that includes the sender registers the sender too", async ({
    request,
    db,
  }) => {
    // "me and my brother are both in" — TWO claims, and the sender's own
    // is as good as any other. Under the old shape this was the case the
    // regex had to be careful not to eat; here it is simply a claim with
    // `subject: "sender"`, and nothing is looking for an excuse to drop it.
    const grp = await mkGroup(request, db);
    await grp.post("amir", "me and my brother are both in", {
      route: "self_att",
      facts: facts([
        claim(),
        claim({ subject: "other", personRef: "my brother", personNamed: false }),
      ]),
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
    expect(await attendanceByName(grp, "brother"), "and still no ghost").toBeNull();
  });

  test("a genuine self standing offer still registers the SENDER", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    await grp.post("amir", "I'll be the 14th if you're short", {
      route: "offer",
      facts: selfIn({ contingent: true, conditionOn: "squad", tense: "future" }),
    });
    // The control this file exists to protect, and it is unchanged.
    //
    // The row's STATUS is capacity's business, not the classifier's (see
    // e2e/sim/bench-capacity.spec.ts). This squad is 3/14, so the offer's
    // own condition ("if you're short") is already met and a bench
    // alongside 11 open slots is exactly the state that produced the
    // "Confirmed (10/14) + Bench (1): Amir" roster.
    expect((await grp.attendanceOf("amir"))?.status).toBe("CONFIRMED");
  });

  test("a third-party-subject OUT is left alone (never strip a drop)", async ({ request, db }) => {
    const grp = await mkGroup(request, db);
    await grp.setAttendance("amir", "CONFIRMED");
    // "my son is ill so cant make it tonight" — the sentence opens with
    // a family member and is entirely about the SENDER. One claim,
    // subject `sender`, polarity `out`.
    await grp.post("amir", "my son is ill so cant make it tonight", {
      route: "self_att",
      facts: selfOut(),
    });
    expect((await grp.attendanceOf("amir"))?.status).toBe("DROPPED");
  });
});
