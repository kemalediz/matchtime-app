/**
 * Group-simulator scenario matrix — ATTENDANCE.
 *
 * Every test drives the REAL analyze pipeline (LLM stubbed) against a
 * fresh virtual group and asserts the bot's reaction, outbound posts/DMs
 * (BotJob rows) and the DB end-state. Covers:
 *   - IN → CONFIRMED, squad-full announcement on the filling IN
 *   - IN at capacity → BENCH
 *   - OUT → DROPPED + open BenchSlotOffer (bench non-empty)
 *   - bench claim in-group (benchConfirmation) → promoted + announce
 *   - admin "move X to bench" → demote, slot freed, NO offer, no dup announce
 *   - benched player's own IN when a slot is free → promoted
 *   - banter "X is out" from a non-admin while X chats → NOT dropped
 *   - third-party OUT for an absent player → honoured
 *   - OUT from someone not registered → silent no-op
 *   - drop → bench-offer → first DM "YES" claims, late claimer misses
 *   - drop → bench-offer → 👍 reaction claims (👎 is a no-op)
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

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
    const r = await grp.post("greg", "in");
    expect(r.handledBy).toBe("llm");
    expect(r.react).toBe("✅");
    expect(await grp.confirmed()).toContain("Greg Gale");
    expect((await grp.counts()).confirmed).toBe(7);
  });

  test("the IN that fills the squad triggers ONE full-line-up announcement", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("henry", "I'm in");
    expect(r.react).toBe("✅");
    expect((await grp.counts()).confirmed).toBe(8);
    const announce = r.groupPosts.find((t) => t.includes("Squad complete"));
    expect(announce).toBeTruthy();
    expect(announce).toContain("8/8");
    // All eight names, numbered; bench empty → no bench block.
    for (const name of await grp.confirmed()) expect(announce).toContain(name);
    expect(announce).not.toContain("Bench");
  });

  test("IN at capacity lands on the BENCH with 🪑", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("ivan", "in");
    expect(r.react).toBe("🪑");
    expect(await grp.bench()).toEqual(["Ivan Ice"]);
    expect((await grp.counts()).confirmed).toBe(8); // capacity respected
  });

  test("OUT → DROPPED + an open BenchSlotOffer for the freed slot", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("pete", "out");
    expect(r.react).toBe("👋");
    expect(await grp.dropped()).toContain("Pete Power");
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0].replacingUserId).toBe(grp.player("pete").userId);
  });

  test("bencher claims the slot in-group → promoted, offer resolved, group told", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("ivan", "yes I'll take it", {
      verdict: {
        intent: "in",
        benchConfirmation: "yes",
        react: "👍",
        confidence: 0.9,
        reasoning: "stub: bench claim",
      },
    });
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
    const r = await grp.post("alice", "Move Pete to the bench please", {
      verdict: {
        intent: "question",
        registerFor: [{ name: "Pete", action: "BENCH" }],
        reply: "Done — Pete Power has moved to the bench. A confirmed spot has opened up.",
        react: "✅",
        confidence: 0.95,
        reasoning: "stub: admin demote",
      },
    });
    expect(r.react).toBe("🪑");
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
    // The announcement passes through exactly ONCE (no safety-net dup).
    const mentions = (r.reply ?? "").match(/moved to the bench/g) ?? [];
    expect(mentions).toHaveLength(1);
  });

  test("benched player's own IN while a slot is free → promoted back", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("pete", "in");
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
      {
        player: "dan",
        body: "😂😂 never, I'm playing",
        verdict: { intent: "noise", react: null, reply: null, confidence: 1, reasoning: "stub" },
      },
      {
        player: "felix",
        body: "Dan is out lads 😂😂",
        verdict: {
          intent: "out",
          registerFor: [{ name: "Dan", action: "OUT" }],
          reply: "Dan is out 😂 We're down to 3/8 — need 5 more!",
          react: "👋",
          confidence: 0.9,
          reasoning: "stub: banter misread as drop",
        },
      },
    ]);
    const banter = batch.results[1];
    expect(banter.reply).toBeNull(); // never announce a refused drop
    expect(banter.react).toBeNull();
    expect((await grp.attendanceOf("dan"))?.status).toBe("CONFIRMED");
  });

  test("third-party OUT for a player NOT in the batch is honoured", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("felix", "Dan can't make it tonight, he told me", {
      verdict: {
        intent: "out",
        registerFor: [{ name: "Dan", action: "OUT" }],
        react: "👋",
        confidence: 0.95,
        reasoning: "stub: genuine relayed drop",
      },
    });
    expect(r.react).toBe("👋");
    expect((await grp.attendanceOf("dan"))?.status).toBe("DROPPED");
    // Bench is empty → no offer to make.
    expect(await grp.openOffers()).toHaveLength(0);
  });

  test("OUT from someone who never registered → silent no-op", async ({ request, db }) => {
    const grp = await group(request, db);
    const r = await grp.post("greg", "out");
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
    await grp.post("pete", "out");
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
    await grp.post("dan", "out");
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
    await grp.post("pete", "out");
    const offers = await grp.openOffers();
    expect(offers).toHaveLength(1);
    const offerId = offers[0].id;

    // A bench player says plain "IN" — self-promotes into the freed slot.
    const r = await grp.post("greg", "in");
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
