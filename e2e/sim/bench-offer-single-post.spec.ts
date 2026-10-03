/**
 * ONE ANNOUNCEMENT PER OPENED SLOT, AND IT SAYS WHICH DAY.
 *
 * ── THE INCIDENT: Sutton FC, Saturday 3 October 2026, 13:33 London ───
 *
 * Tuesday 6 October 7-a-side, squad full, Ozgur on the bench. Raihan:
 * "I'm out for Tuesday. Picked up an injury". MatchTime then posted the
 * SAME slot twice, a few seconds apart:
 *
 *   1. the analyze reply, from the engine's `bench_offer_open` speech:
 *      "A slot just opened 🎟 Ozgur, first to say IN takes it. Nobody
 *       gets dropped."
 *   2. the scheduler's BenchSlotOffer group post (`offer-<id>`):
 *      "🎟 A slot just opened for *Tuesday 7-a-side* tonight. *First to
 *       claim it plays.* @Ozgur ..."  plus a DM to Ozgur.
 *
 * and (2) said "tonight" on a Saturday for a Tuesday match.
 *
 * Both paths are driven here together, through the real routes: the
 * drop through /api/whatsapp/analyze, then a scheduler tick through
 * /api/whatsapp/due-posts at a pinned clock. Exactly one group-facing
 * message may announce the slot, and it must name the day.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { londonAt } from "../helpers/constants";
import { claim, clearExtractorStub, clearRouterStub, facts, setExtractorStub, setRouterStub } from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe.skip : test.describe)("a drop with a bench is announced ONCE (2026-10-03)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  const SEVEN = ["owner", "alice", "brian", "pete", "dan", "felix", "greg"];
  const RAIHAN = "I'm out for Tuesday. Picked up an injury";

  function dropStub() {
    setRouterStub({ floor: false, bodies: { [RAIHAN]: "self_att" } });
    setExtractorStub({ bodies: { [RAIHAN]: facts([claim({ polarity: "out" })]) } });
  }

  test("THE INCIDENT: analyze says nothing about the slot; the offer post says it once, with the day", async ({
    request,
    db,
  }) => {
    const g = await createGroup(request, db, {
      maxPlayers: 7,
      upcomingMatch: { daysFromNow: 3 },
      attendance: [...SEVEN.map((key) => ({ key, status: "CONFIRMED" as const })), { key: "quinn", status: "BENCH" as const }],
    });
    // Kickoff three days out at 21:30 London: a Saturday drop for a
    // Tuesday match, as on the day.
    const kickoff = londonAt(3, 21, 30);
    await db.run(`UPDATE "Match" SET date = $1, "attendanceDeadline" = $1 WHERE id = $2`, [kickoff, g.matchId]);

    dropStub();
    const res = await g.postBatch([{ player: "pete", body: RAIHAN }]);
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
    expect(await g.counts()).toMatchObject({ confirmed: 6, bench: 1 });
    expect(await g.openOffers()).toHaveLength(1);

    // The analyze side: the react on the message, and no sentence of its own.
    expect(res.results[0].react).toBe("👋");
    const analyzeAnnouncements = [
      ...res.results.map((r) => r.reply ?? "").filter((t) => t.length > 0),
      ...res.groupPosts,
    ];
    expect(analyzeAnnouncements).toEqual([]);

    // The scheduler side, at 13:33 London today (inside the 08:00-21:59
    // daytime gate), claiming as the Pi does.
    const tick = await g.duePosts(londonAt(0, 13, 33), { claim: true });
    const groupFacing = tick.filter((i) => i.kind !== "dm" && /slot just opened/i.test(i.text ?? ""));
    expect(groupFacing).toHaveLength(1);
    const post = groupFacing[0];
    expect(post.kind).toBe("bench-prompt");
    expect(post.key).toMatch(/^offer-/);
    expect(post.text).toContain(`@${g.player("quinn").phone!.replace(/^\+/, "")}`);

    // Every slot announcement the group saw, from both paths together.
    expect([...analyzeAnnouncements, ...groupFacing.map((i) => i.text)]).toHaveLength(1);

    // It names the day, never "tonight", for a match three days out.
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" })
      .format(kickoff)
      .replace(",", "");
    expect(post.text).not.toMatch(/tonight/i);
    expect(post.text).toContain(`on ${day}.`);

    // The DM to the bench is kept, once, and names the day too.
    const dms = tick.filter((i) => i.kind === "dm" && (i.key ?? "").startsWith(`${post.key}:dm:`));
    expect(dms).toHaveLength(1);
    expect(dms[0].targetUser).toBe(g.player("quinn").userId);
    expect(dms[0].text).not.toMatch(/tonight/i);
    expect(dms[0].text).toContain(`on ${day}`);

    // A second tick sends nothing again.
    const again = await g.duePosts(londonAt(0, 13, 34), { claim: true });
    expect(again.filter((i) => (i.key ?? "").startsWith("offer-"))).toEqual([]);
  });
});
