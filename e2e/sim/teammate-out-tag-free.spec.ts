/**
 * Group simulator: A PLAYER SAYS A TEAMMATE IS OUT, UNTAGGED (2026-11-02).
 *
 * Sutton FC, 2 Nov 2026. Zair, an ordinary player, posted untagged
 * "Sorry, Ismayil is out". The router read other_att, the extractor read
 * a third-party OUT at 0.95, and the engine refused it for want of an
 * @Match Time tag, so Ismayil stayed on the list. Kemal's ruling:
 * attendance never needs a tag in the players' group.
 *
 * Drives the REAL analyze pipeline with the router and extractor stubbed
 * (no model calls), so the gate, the write and the bench-offer chain are
 * the production ones. The roster's players stand in for the real names:
 * Dan Drummer is Zair, Pete Power is Ismayil.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { addMatchAvailabilityBodies, otherFacts } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const squadWithBench = [
  { key: "owner", status: "CONFIRMED" },
  { key: "alice", status: "CONFIRMED" },
  { key: "pete", status: "CONFIRMED" },
  { key: "dan", status: "CONFIRMED" },
  { key: "felix", status: "CONFIRMED" },
  { key: "greg", status: "BENCH" },
] as const;

test.describe("a player's untagged \"Sorry, X is out\"", () => {
  test("drops the teammate, frees the slot and offers it to the bench, as any OUT does", async ({
    request,
    db,
  }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 5, attendance: [...squadWithBench] })).attach(request);
    expect(await grp.confirmed()).toContain("Pete Power");

    const r = await grp.post("dan", "Sorry, Pete Power is out", {
      route: "other_att",
      facts: otherFacts("Pete Power", "out"),
    });

    expect(r.handledBy).toBe("llm");
    expect(r.intent).not.toBe("noise");
    expect(r.react).toBe("👍");
    expect(await grp.dropped()).toContain("Pete Power");
    expect(await grp.confirmed()).not.toContain("Pete Power");
    expect((await grp.counts()).confirmed).toBe(4);
    // The sender only reported it: he keeps his own place.
    expect((await grp.attendanceOf("dan"))?.status).toBe("CONFIRMED");

    // The freed slot is offered to the bench, and the offer is claimable.
    expect(await grp.openOffers()).toHaveLength(1);
    addMatchAvailabilityBodies({ YES: "in" }); // the bench offer's YES, read by the model (stubbed)
    const claim = await grp.dm("greg", "YES");
    expect(claim.json.result).toBe("confirmed");
    expect((await grp.attendanceOf("greg"))?.status).toBe("CONFIRMED");
  });

  test("is the same write the tagged message makes", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 5, attendance: [...squadWithBench] })).attach(request);
    const r = await grp.post("dan", "@Match Time Pete Power is out", {
      route: "other_att",
      facts: otherFacts("Pete Power", "out"),
      tag: true,
    });
    expect(r.react).toBe("👍");
    expect(await grp.dropped()).toContain("Pete Power");
    expect(await grp.openOffers()).toHaveLength(1);
  });
});

test.describe("an untagged bench of a teammate", () => {
  test("from a PLAYER: nothing changes (the admin-only bench guard, not the tag)", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 5, attendance: [...squadWithBench] })).attach(request);
    const r = await grp.post("dan", "put Pete Power on the bench", {
      route: "other_att",
      facts: otherFacts("Pete Power", "bench"),
    });
    expect(await grp.confirmed()).toContain("Pete Power");
    expect(await grp.bench()).not.toContain("Pete Power");
    expect(r.react).toBeNull();
  });

  test("from an ADMIN: the teammate is benched", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 5, attendance: [...squadWithBench] })).attach(request);
    await grp.post("alice", "put Pete Power on the bench", {
      route: "other_att",
      facts: otherFacts("Pete Power", "bench"),
    });
    expect(await grp.bench()).toContain("Pete Power");
    expect(await grp.confirmed()).not.toContain("Pete Power");
  });
});
