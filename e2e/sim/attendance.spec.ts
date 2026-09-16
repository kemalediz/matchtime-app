/**
 * Group-simulator scenario matrix — ATTENDANCE.
 *
 * Every test drives the REAL analyze pipeline (router + extractor
 * stubbed) against a fresh virtual group and asserts the bot's reaction,
 * outbound posts/DMs (BotJob rows) and the DB end-state. Covers:
 *   - IN → CONFIRMED, squad-full announcement on the filling IN
 *   - IN at capacity → BENCH
 *   - OUT → DROPPED + open BenchSlotOffer (bench non-empty)
 *   - bench PROMPT answered in the group → promoted + announce
 *   - admin "move X to bench" → demote, slot freed, NO offer, no dup announce
 *   - benched player's own IN when a slot is free → promoted
 *   - banter "X is out" from a non-admin while X chats → NOT dropped
 *   - third-party OUT for an absent player → honoured
 *   - OUT from someone not registered → silent no-op
 *   - drop → bench-offer → first DM "YES" claims, late claimer misses
 *   - drop → bench-offer → 👍 reaction claims (👎 is a no-op)
 *
 * ── PORTED 2026-09-06, §10 STEP 8 ───────────────────────────────────
 *
 * Every `verdict:` became a `route` plus the FACTS the extractor reads
 * out of that body, so each case now pins the ENGINE's decision instead
 * of asserting a write it had already asked for. Three assertions
 * changed value and each says why at its own site:
 *
 *   • the two third-party moves react 👍, not 🪑 / 👋. `reactFor` gives
 *     a status react only when the SENDER's own row moved, and the old
 *     values described the subject rather than the speaker.
 *   • the in-group bench claim now needs a real `PendingBenchConfirmation`
 *     row, because `verdict.benchConfirmation` used to reach
 *     `resolveBenchConfirmation` without one.
 *
 * `benchConfirmation`, `registerAttendance` and `registerFor` have no
 * successor fields; `subject` + `polarity` per claim carry all three.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { claim, facts, otherFacts, selfIn, selfOut } from "../helpers/stub";
import { buildSquadCompleteBenchInvite } from "../../src/lib/bench-offer-copy";

/** The two bodies this file posts most: a plain self IN and a plain self
 *  OUT, as the FACTS the extractor reads out of them. Everything that
 *  happens next — a slot, a bench seat, a promotion, a freed slot, a
 *  bench-slot offer — is `pipeline/engine.ts` deciding, which is the
 *  whole point of the port. */
const IN = { route: "self_att", facts: selfIn() };
const OUT = { route: "self_att", facts: selfOut() };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// ── A. capacity lifecycle ───────────────────────────────────────────────

test.describe("capacity lifecycle", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 8,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "brian", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    })).attach(request);

  test("IN → CONFIRMED with ✅", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("greg", "in", IN);
    expect(r.handledBy).toBe("llm");
    expect(r.react).toBe("✅");
    expect(await grp.confirmed()).toContain("Greg Gale");
    expect((await grp.counts()).confirmed).toBe(7);
  });

  test("the IN that fills the squad triggers ONE full-line-up announcement", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("henry", "I'm in", IN);
    expect(r.react).toBe("✅");
    expect((await grp.counts()).confirmed).toBe(8);
    const announce = r.groupPosts.find((t) => t.includes("Squad complete"));
    expect(announce).toBeTruthy();
    expect(announce).toContain("8/8");
    // All eight names, numbered; bench empty → no bench block.
    for (const name of await grp.confirmed()) expect(announce).toContain(name);
    expect(announce).not.toContain("*Bench (");
    // Bench feature on (the sim default): the SAME post ends by inviting
    // benchers, so the owner never has to ask (Sutton, 2026-09-16).
    expect(announce!.endsWith(buildSquadCompleteBenchInvite())).toBe(true);
    expect(r.groupPosts.filter((t) => t.includes("Bench is open"))).toHaveLength(1);
  });

  test("bench feature OFF: the squad-complete post ends as it always did, no invite", async ({
    request,
    db,
  }) => {
    // A separate group: the lifecycle group above is shared and serial.
    const off = await createGroup(request, db, {
      maxPlayers: 8,
      features: { bench: false },
      attendance: ["owner", "alice", "brian", "pete", "dan", "felix", "greg"].map((key) => ({
        key,
        status: "CONFIRMED" as const,
      })),
    });
    const r = await off.post("henry", "I'm in", IN);
    expect((await off.counts()).confirmed).toBe(8);
    const announce = r.groupPosts.find((t) => t.includes("Squad complete"));
    expect(announce).toBeTruthy();
    expect(announce!.endsWith("See you all there ⚽")).toBe(true);
    expect(announce).not.toContain("Bench is open");
  });

  test("IN at capacity lands on the BENCH with 🪑", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("ivan", "in", IN);
    expect(r.react).toBe("🪑");
    expect(await grp.bench()).toEqual(["Ivan Ice"]);
    expect((await grp.counts()).confirmed).toBe(8); // capacity respected
  });

  test("OUT → DROPPED + an open BenchSlotOffer for the freed slot", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("pete", "out", OUT);
    expect(r.react).toBe("👋");
    expect(await grp.dropped()).toContain("Pete Power");
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0].replacingUserId).toBe(grp.player("pete").userId);
  });

  test("bencher claims the slot in-group → promoted, offer resolved, group told", async ({ request, db }) => {
    const grp = await group(request, db);
    // ── PORTED 2026-09-06, §10 STEP 8, AND IT NOW DRIVES THE REAL
    //    SHIPPED PATH RATHER THAN A FIELD THAT SHORT-CIRCUITED IT ─────
    //
    // This used `verdict.benchConfirmation = "yes"`, which
    // `executeVerdict` handed straight to `resolveBenchConfirmation`.
    // There is no such field, and there is deliberately no successor:
    // `attendance-engine-batch.ts` REFUSES this shape ("a bare 'yes'
    // from someone with a prompt open") because a
    // `PendingBenchConfirmation` is a different table and a different
    // flow from the `BenchSlotOffer` the engine models.
    //
    // What handles it now is `lib/bench-prompt-answer.ts`, consulted by
    // `analyze/route.ts` ONLY when the database says this exact sender
    // has an unanswered prompt open for this match. That prior is the
    // whole mechanism — it is what lets a bare "yes" be read without a
    // model — so the row has to exist for the path to be reachable, and
    // the old verdict field is precisely what let the test skip it.
    // Seeding it is not scaffolding; it is the trigger.
    //
    // The body changed too. "yes I'll take it" is five words with a
    // second clause and `readBenchPromptAnswer` returns null for it BY
    // DESIGN ("anything carrying a second clause, a condition or a
    // question mark returns null"). That is a real narrowing versus the
    // mega-prompt, it is documented in that file's "What is LOST"
    // section, and it is the conservative direction.
    await grp.db.run(
      `INSERT INTO "PendingBenchConfirmation" (id, "matchId", "userId", "expiresAt", "replacingUserId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'UTC') + interval '2 hours', $4,
               now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
      [`pbc-${grp.orgId}`, grp.matchId, grp.player("ivan").userId, grp.player("pete").userId],
    );

    const r = await grp.post("ivan", "yes");
    expect(r.handledBy).toBe("fast-path");
    expect(r.intent).toBe("bench_confirmation");
    expect(r.react).toBe("✅");
    expect((await grp.attendanceOf("ivan"))?.status).toBe("CONFIRMED");
    expect(await grp.openOffers()).toHaveLength(0);
    // The claim announce names both sides; the refilled squad announces again
    // (the dedupe key is cleared on every confirmed-drop).
    const claim = r.groupPosts.find((t) => t.includes("replacing"));
    expect(claim).toBeTruthy();
    expect(claim).toContain("Ivan Ice");
    expect(claim).toContain("Pete Power");
    expect(r.groupPosts.some((t) => t.includes("Squad complete"))).toBe(true);
    expect((await grp.counts()).confirmed).toBe(8);
  });
});

// ── B. admin demote + bench re-promotion ───────────────────────────────

test.describe("admin demote and re-promotion", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    })).attach(request);

  test('admin "move Pete to the bench" → demote, slot freed, NO offer, single announce', async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("alice", "@Match Time move Pete to the bench please", {
      // Interaction contract: moving ANOTHER player is a directed op →
      // requires an @Match Time tag.
      tag: true,
      route: "other_att",
      facts: otherFacts("Pete", "bench"),
    });
    // 👍, not 🪑. `pipeline/engine.ts:reactFor` gives a status react only
    // when the SENDER's own row moved; Alice is still confirmed and it is
    // Pete who was benched, so a 🪑 on her message would say she had been.
    // The old value came from the verdict's react being recomputed
    // against the write rather than against the sender.
    expect(r.react).toBe("👍");
    expect((await grp.attendanceOf("pete"))?.status).toBe("BENCH");
    expect((await grp.counts()).confirmed).toBe(4); // slot freed
    // Exactly one attendance row for Pete — demote, not re-registration.
    expect(
      await grp.db.count(
        `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
        [grp.matchId, grp.player("pete").userId],
      ),
    ).toBe(1);
    // A demote never opens a bench-slot offer.
    expect(await grp.openOffers()).toHaveLength(0);
    // The move is announced exactly ONCE. It used to count the phrase
    // "moved to the bench", which was the MODEL's wording passed through;
    // the composer writes the sentence now, so the assertion counts
    // mentions of the player instead of a phrase nobody owns.
    const mentions = (r.reply ?? "").match(/Pete/g) ?? [];
    expect(mentions.length, `announced once, in: ${r.reply}`).toBe(1);
  });

  test("benched player's own IN while a slot is free → promoted back", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("pete", "in", IN);
    expect(r.react).toBe("✅");
    expect((await grp.attendanceOf("pete"))?.status).toBe("CONFIRMED");
    expect((await grp.counts()).confirmed).toBe(5);
    expect(await grp.bench()).toHaveLength(0);
  });
});

// ── C. banter-drop guard + third-party OUT ──────────────────────────────

test.describe("third-party drops", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 8,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
      ],
    })).attach(request);

  test('banter "Dan is out 😂" from a non-admin while Dan chats → NOT dropped, bot silent', async ({ request, db }) => {
    const grp = await group(request, db);
    const batch = await grp.postBatch([
      // Dan protests, in the same batch. The extractor reports the IN
      // claim his message really makes; the banter guard needs him to
      // have SPOKEN and not corroborated the drop.
      {
        player: "dan",
        body: "😂😂 never, I'm playing",
        route: "self_att",
        facts: selfIn(),
      },
      // And the wind-up. The extractor CORRECTLY reports the OUT claim —
      // the text contains it — which is exactly §6.2's point: deciding
      // it is banter needs corroboration only the engine can see.
      {
        player: "felix",
        body: "Dan is out lads 😂😂",
        route: "other_att",
        facts: otherFacts("Dan", "out"),
      },
    ]);
    const banter = batch.results[1];
    expect(banter.reply).toBeNull(); // never announce a refused drop
    expect(banter.react).toBeNull();
    expect((await grp.attendanceOf("dan"))?.status).toBe("CONFIRMED");
  });

  test("third-party OUT for a player NOT in the batch is honoured", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("felix", "@Match Time Dan can't make it tonight, he told me", {
      // Interaction contract: dropping ANOTHER player is a directed op →
      // requires an @Match Time tag. `reported: true` is the fact that
      // "he told me" carries.
      tag: true,
      route: "other_att",
      facts: otherFacts("Dan", "out", { reported: true }),
    });
    // 👍 rather than 👋, for the same reason as the demote above: Felix's
    // own row did not move, and a 👋 on his message would read as Felix
    // leaving. `reactFor(status, self)` is the one place that decides it.
    expect(r.react).toBe("👍");
    expect((await grp.attendanceOf("dan"))?.status).toBe("DROPPED");
    // Bench is empty → no offer to make.
    expect(await grp.openOffers()).toHaveLength(0);
  });

  test("OUT from someone who never registered → silent no-op", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("greg", "out", OUT);
    expect(r.react).toBeNull();
    expect(r.reply).toBeNull();
    expect(await grp.attendanceOf("greg")).toBeNull();
  });
});

// ── D. bench-offer claims: DM race + reactions ──────────────────────────

test.describe("bench-offer claim lifecycle", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
        { key: "greg", status: "BENCH" },
        { key: "henry", status: "BENCH" },
      ],
    })).attach(request);

  test('drop → offer → first bencher DMs "YES" → promoted + ack + group announce', async ({ request, db }) => {
    const grp = await group(request, db);
    await grp.post("pete", "out", OUT);
    expect(await grp.openOffers()).toHaveLength(1);

    const r = await grp.dm("greg", "YES");
    expect(r.json.handled).toBe("bench-dm");
    expect(r.json.result).toBe("confirmed");
    expect((await grp.attendanceOf("greg"))?.status).toBe("CONFIRMED");
    expect(await grp.openOffers()).toHaveLength(0);
    // Personal ack DM to Greg + a group announcement.
    const gregPhone = grp.player("greg").phone!.replace(/^\+/, "");
    expect(r.dms.some((d) => d.phone === gregPhone && /you'?re in/i.test(d.text))).toBe(true);
    expect(r.groupPosts.some((t) => t.includes("Greg Gale"))).toBe(true);
  });

  test("late claimer after the slot went → still on the bench, nothing changes", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.dm("henry", "YES");
    // No open offer anywhere → the bench-DM branch never engages.
    expect(r.json.handled).toBeUndefined();
    expect((await grp.attendanceOf("henry"))?.status).toBe("BENCH");
  });

  test("next drop → 👎 reaction is a no-op, 👍 reaction claims the slot", async ({ request, db }) => {
    const grp = await group(request, db);
    await grp.post("dan", "out", OUT);
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    // Simulate the Pi ACKing the posted offer message id.
    const offerMsgId = `sim-offer-${Date.now()}`;
    await grp.db.run(`UPDATE "BenchSlotOffer" SET "waMessageId" = $1 WHERE id = $2`, [
      offerMsgId,
      offers[0].id,
    ]);

    const declined = await grp.reaction(offerMsgId, "👎", "henry");
    expect(declined.outcome).toBe("declined");
    expect((await grp.attendanceOf("henry"))?.status).toBe("BENCH"); // never eliminated

    const claimed = await grp.reaction(offerMsgId, "👍", "henry");
    expect(claimed.outcome).toBe("confirmed");
    expect((await grp.attendanceOf("henry"))?.status).toBe("CONFIRMED");
    expect(await grp.openOffers()).toHaveLength(0);
  });
});

// ── E. self-promotion (plain "IN") resolves the dangling bench offer ─────
//
// A confirmed player drops → an open BenchSlotOffer is created. A BENCH
// player then says plain "IN" and self-promotes into the freed slot. The
// offer is now satisfied by that very self-promotion, so it must be CLOSED
// (resolvedAt set, outcome "claimed") — not left dangling until the
// kickoff sweep (which would keep the scheduler emitting bench prompts).

test.describe("self-promotion resolves the open bench offer", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" }, // squad full at 5/5
        { key: "greg", status: "BENCH" },
        { key: "henry", status: "BENCH" },
      ],
    })).attach(request);

  test('drop → open offer → benched "IN" self-promotes AND closes the offer', async ({ request, db }) => {
    const grp = await group(request, db);

    // Confirmed player drops → a slot frees up + an open offer is created.
    await grp.post("pete", "out", OUT);
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    const offerId = offers[0].id;

    // A bench player says plain "IN" — self-promotes into the freed slot.
    const r = await grp.post("greg", "in", IN);
    expect(r.react).toBe("✅");
    expect((await grp.attendanceOf("greg"))?.status).toBe("CONFIRMED");
    expect((await grp.counts()).confirmed).toBe(5);

    // The offer must no longer dangle — closed with outcome "claimed".
    expect(await grp.openOffers()).toHaveLength(0);
    const resolved = await grp.db.one<{
      resolvedAt: string | null;
      outcome: string | null;
      claimedByUserId: string | null;
    }>(
      `SELECT "resolvedAt", outcome, "claimedByUserId" FROM "BenchSlotOffer" WHERE id = $1`,
      [offerId],
    );
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.outcome).toBe("claimed");
    expect(resolved?.claimedByUserId).toBe(grp.player("greg").userId);
  });
});

// ── F. admin-directed promote a specific bench player ───────────────────
// An ADMIN names a bench player to bring up and a confirmed player to drop
// for them ("move Aydın from bench to squad to replace Ehtisham"). The bot
// must DIRECTLY promote the bench player (no thumbs-up confirmation), drop
// the named player, close the freed slot's offer, and report the bench
// player IN / squad full. A NON-admin issuing the same instruction must
// NOT be able to promote (the admin role, not capacity, is the gate).

const PROMOTE_ROSTER = [
  { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
  { key: "alice", name: "Alice Admin", role: "ADMIN" as const },
  { key: "pete", name: "Pete Power" },
  { key: "dan", name: "Dan Drummer" },
  { key: "ehtisham", name: "Ehtisham Ekin" },
  { key: "aydin", name: "Aydın Arslan" },
  { key: "salman", name: "Salman Saric" },
];

test.describe("admin-directed promote a specific bench player", () => {
  // Test A — the exact reported exchange. Squad full at 5/5 with Ehtisham
  // filling the last slot; Aydın + Salman on the bench. An admin says
  // "move Aydın from bench to squad to replace Ehtisham".
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      players: PROMOTE_ROSTER,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "ehtisham", status: "CONFIRMED" }, // squad full at 5/5
        { key: "aydin", status: "BENCH" },
        { key: "salman", status: "BENCH" },
      ],
    })).attach(request);

  test('admin "move Aydın from bench to replace Ehtisham" → Aydın IN, Ehtisham dropped, offer closed, squad full', async ({
    request,
    db,
  }) => {
    const grp = await group(request, db);

    // The decisive admin instruction. OUT for Ehtisham FIRST (frees the
    // slot + opens an offer), then IN for Aydın WITH promoteFromBench
    // (admin sender) → fills the slot and resolves the offer.
    const r = await grp.post("alice", "@Match Time move Aydın from bench to squad to replace Ehtisham", {
      // Interaction contract: promoting/replacing OTHER players is a
      // directed op → requires an @Match Time tag.
      tag: true,
      route: "other_att",
      facts: facts([
        claim({ subject: "other", personRef: "Ehtisham", personNamed: true, polarity: "out" }),
        claim({ subject: "other", personRef: "Aydın", personNamed: true, polarity: "in" }),
      ]),
    });

    // End-state: Ehtisham dropped, Aydın confirmed, squad full, Salman
    // untouched on the bench, no dangling offer.
    expect(await grp.dropped()).toContain("Ehtisham Ekin");
    expect(await grp.confirmed()).not.toContain("Ehtisham Ekin");
    expect((await grp.attendanceOf("aydin"))?.status).toBe("CONFIRMED");
    expect(await grp.confirmed()).toContain("Aydın Arslan");
    expect((await grp.counts()).confirmed).toBe(grp.maxPlayers);
    expect(await grp.confirmed()).not.toContain("Salman Saric");
    expect(await grp.openOffers()).toHaveLength(0);

    // The reply must reflect Aydın IN / squad full — never "asking the
    // bench" or "until they confirm" (X is genuinely confirmed).
    const finalText = [r.reply ?? "", ...r.groupPosts].join("\n");
    expect(finalText).not.toMatch(/asking the bench/i);
    expect(finalText).not.toMatch(/until .*confirm/i);
    expect(finalText).toMatch(/Aydın|5\/5/);
  });
});

// ── G. SELF-REPLACE: a player drops THEMSELVES for a named bench player ──
// The exact Kemal-reported intent: "the real issue here is extra steps of
// asking Aydin — when a player tells MT to replace them with someone from
// the bench, it should just do it." Ehtisham (a CONFIRMED, NON-admin
// player) posts "replace me with Aydın". MatchTime must DIRECTLY drop
// Ehtisham and promote Aydın off the bench into the freed slot — NO 👍
// bench-confirmation step, no dangling offer. This is authorised because
// the sender IS the player being dropped (self-replace), even though
// they're not an admin.

test.describe("self-replace: player swaps themselves for a bench player", () => {
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      players: PROMOTE_ROSTER,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "ehtisham", status: "CONFIRMED" }, // squad full at 5/5
        { key: "aydin", status: "BENCH" },
        { key: "salman", status: "BENCH" },
      ],
    })).attach(request);

  test('non-admin "replace me with Aydın" → Aydın IN, sender OUT, NO 👍 step, offer closed, squad full', async ({
    request,
    db,
  }) => {
    const grp = await group(request, db);

    // Ehtisham is a plain PLAYER (not in the OWNER/ADMIN seats). He gives
    // up his OWN slot for Aydın — the same OUT/IN registerFor pair the
    // admin-directed promote uses; the OUT target is the sender himself.
    const r = await grp.post("ehtisham", "@Match Time can't make it — replace me with Aydın from the bench", {
      // Interaction contract: although the OUT half is the sender's own
      // self-attendance (tag-free), the message ALSO promotes a named
      // bench player (Aydın) — a directed op on another player — so the
      // whole self-replace flow requires an @Match Time tag.
      tag: true,
      route: "other_att",
      // The OUT is about the SENDER, which is what makes this a
      // self-replace rather than roster surgery on somebody else, and
      // `subject` is the field that says so.
      facts: facts([
        claim({ polarity: "out" }),
        claim({ subject: "other", personRef: "Aydın", personNamed: true, polarity: "in" }),
      ]),
    });

    // End-state: Ehtisham dropped, Aydın promoted into the squad, squad
    // back to full, Salman left untouched on the bench.
    expect(await grp.dropped()).toContain("Ehtisham Ekin");
    expect(await grp.confirmed()).not.toContain("Ehtisham Ekin");
    expect((await grp.attendanceOf("aydin"))?.status).toBe("CONFIRMED");
    expect(await grp.confirmed()).toContain("Aydın Arslan");
    expect((await grp.counts()).confirmed).toBe(grp.maxPlayers);
    expect((await grp.attendanceOf("salman"))?.status).toBe("BENCH");

    // The promotion was DIRECT — no bench-confirmation step. There must be
    // no dangling open offer, and nothing in the bot's output may ask
    // anyone to react with 👍 to confirm / step up / take the slot.
    expect(await grp.openOffers()).toHaveLength(0);
    const finalText = [r.reply ?? "", ...r.groupPosts, ...r.dms.map((d) => d.text)].join("\n");
    expect(finalText).not.toMatch(/👍/);
    expect(finalText).not.toMatch(/react .* to confirm/i);
    expect(finalText).not.toMatch(/asking the bench/i);
    expect(finalText).not.toMatch(/until .*confirm/i);
    expect(finalText).not.toMatch(/step up/i);
    // It should read as a done deal naming Aydın / a full squad.
    expect(finalText).toMatch(/Aydın|5\/5/);
  });
});

// ── H. OFF-LIST joiner grabbing the LAST slot closes the open offer ──────
//
// Regression for the dangling-offer bug (2026-06): a player on NEITHER the
// squad NOR the bench (a general group member) posts plain "IN" and grabs
// the LAST open squad slot. The squad goes full, but the offer-close used
// to be gated on `selfPromoted` (which requires an existing BENCH row), so
// an off-list joiner left the open BenchSlotOffer dangling. The scheduler
// would then keep emitting "asking the bench to step up" nudges for a slot
// that no longer exists. The fix decouples the offer-close from
// `selfPromoted`: whenever a confirm fills the squad, ALL open offers close.

test.describe("off-list joiner taking the last slot closes the open offer", () => {
  let g: SimGroup;
  // owner, alice (admin), pete, dan, felix are CONFIRMED (5/5 full); greg is
  // BENCH; quinn is a plain group MEMBER with no attendance row at all (not
  // on the squad, not on the bench).
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" }, // squad full at 5/5
        { key: "greg", status: "BENCH" },
      ],
    })).attach(request);

  test('drop → open offer → OFF-LIST member "IN" fills last slot AND closes the offer (no more bench nudge)', async ({
    request,
    db,
  }) => {
    const grp = await group(request, db);

    // A confirmed player drops → a slot frees up + an open offer is created.
    await grp.post("pete", "out", OUT);
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    const offerId = offers[0].id;
    // Sanity: quinn has no attendance row — genuinely off-list.
    expect(await grp.attendanceOf("quinn")).toBeNull();

    // Quinn (not squad, not bench) says plain "IN" and grabs the last slot.
    const r = await grp.post("quinn", "in", IN);
    expect(r.react).toBe("✅");
    expect((await grp.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
    expect((await grp.counts()).confirmed).toBe(5); // squad full again

    // The offer must no longer dangle — closed with outcome "claimed".
    expect(await grp.openOffers()).toHaveLength(0);
    const resolved = await grp.db.one<{
      resolvedAt: string | null;
      outcome: string | null;
      claimedByUserId: string | null;
    }>(
      `SELECT "resolvedAt", outcome, "claimedByUserId" FROM "BenchSlotOffer" WHERE id = $1`,
      [offerId],
    );
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.outcome).toBe("claimed");
    expect(resolved?.claimedByUserId).toBe(grp.player("quinn").userId);

    // A subsequent scheduler tick must NOT emit another "asking the bench"
    // nudge for this match — the offer that would have driven it is closed.
    const instructions = await grp.duePosts(new Date());
    const benchNudge = instructions.find(
      (i) =>
        i.kind === "bench-prompt" ||
        /asking the bench|step up|spot.*open/i.test(i.text ?? ""),
    );
    expect(benchNudge).toBeUndefined();
  });

  test("OFF-LIST member IN while slots remain → lands in squad, offer STAYS open", async ({
    request,
    db,
  }) => {
    const grp = await group(request, db);
    // Squad is full (5/5) with quinn from the previous test. Two players drop
    // → two open slots → one open offer. A single off-list joiner fills only
    // ONE slot; the squad is still short, so the offer must remain open for
    // the bench.
    await grp.post("owner", "out", OUT);
    await grp.post("alice", "out", OUT);
    expect((await grp.counts()).confirmed).toBe(3); // 3/5 — two slots open
    const openBefore = await grp.openOffers();
    expect(openBefore.length).toBeGreaterThanOrEqual(1);

    // ryan is another off-list member; fills just one of the two slots.
    const r = await grp.post("ryan", "in", IN);
    expect(r.react).toBe("✅");
    expect((await grp.counts()).confirmed).toBe(4); // 4/5 — still one open
    // Squad NOT full → the offer must NOT be closed.
    expect((await grp.openOffers()).length).toBeGreaterThanOrEqual(1);
  });
});

test.describe("unrelated non-admin cannot promote a bench player into the squad", () => {
  // Test B (now the UNRELATED-THIRD-PARTY case) — NEGATIVE. A genuinely
  // free slot exists (4/5), so the ONLY thing preventing promotion is
  // authorisation. Bilal is neither an admin NOR the player being
  // dropped — he nominates SOMEONE ELSE'S replacement: "replace Ehtisham
  // with Aydın". Aydın must STAY on the bench. (Contrast Test G above,
  // where the sender drops *themselves* and the promote DOES go through;
  // and Test F, where an admin drives it.)
  const BILAL_ROSTER = [...PROMOTE_ROSTER, { key: "bilal", name: "Bilal Bright" }];
  let g: SimGroup;
  const group = async (request: APIRequestContext, db: TestDb) =>
    (g ??= await createGroup(request, db, {
      maxPlayers: 5,
      players: BILAL_ROSTER,
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "ehtisham", status: "CONFIRMED" }, // 4/5 — one slot genuinely free
        { key: "aydin", status: "BENCH" },
      ],
    })).attach(request);

  test('non-admin "replace Ehtisham with Aydın" (sender is neither) → Aydın stays BENCH', async ({
    request,
    db,
  }) => {
    const grp = await group(request, db);
    // bilal is a plain PLAYER and is NOT Ehtisham — he can't pick the
    // replacement. The IN must NOT promote despite the free slot.
    // Tagged so the message clears the interaction-contract gate and
    // actually reaches the promote-AUTHORISATION gate — that's the gate
    // under test here (an unrelated non-admin must not promote). Without
    // the tag the contract gate would suppress it for a different reason,
    // masking the authorisation check.
    await grp.post("bilal", "@Match Time replace Ehtisham with Aydın from the bench", {
      tag: true,
      route: "other_att",
      facts: facts([
        claim({ subject: "other", personRef: "Ehtisham", personNamed: true, polarity: "out" }),
        claim({ subject: "other", personRef: "Aydın", personNamed: true, polarity: "in" }),
      ]),
    });

    // The free slot was available, yet the unrelated non-admin's IN did
    // NOT promote Aydın — the authorisation gate blocked it. (The banter-
    // drop guard also protects Ehtisham, who isn't speaking, but the
    // load-bearing assertion here is that Aydın was NOT promoted.)
    expect((await grp.attendanceOf("aydin"))?.status).toBe("BENCH");
    expect(await grp.bench()).toContain("Aydın Arslan");
    expect(await grp.confirmed()).not.toContain("Aydın Arslan");
  });
});
