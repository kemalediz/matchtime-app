/**
 * FRIEND LINK SCENARIOS, SLICE S2: a player says a friend is coming
 * (Kemal, 2026-10-31; plan MDs/friend-link-plan-2026-10-31.md).
 *
 * MatchTime adds nobody, posts no roster and asks no name. It reacts ✉️ and
 * DMs the player a personal link for the friend to forward. An organiser
 * keeps today's direct add (D1). Real routes, stubbed router and extractor,
 * $0.
 */
import { scenario, scenarios, expect } from "../pool/fixtures";
import { otherFacts } from "../../helpers/stub";
import { friendClub, friendLinkRows, linksIn, namedFriend, say, unnamedFriend } from "./world";
import { facts, claim } from "../../helpers/stub";

const HOW = "Your friend can only join this game by opening the link, filling in their details and sending the WhatsApp code it gives them. Each link works for one person, until kick-off.";

scenarios("a player says a friend is coming", () => {
  scenario("a named friend: ✉️, one DM to the player with Ali's link, nobody added, nothing in the group", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const r = await say(pool, fnf, "shane", "my friend Ali is in", namedFriend("Ali"));

    expect(r.react).toBe("✉️");
    pool.expectSent(r.sent, [{ to: "fnf.shane", channel: "dm", text: /^Here's the link for Ali to join \*FNF\* on \w{3} \d+ \w{3}, 20:00 at Sim Arena\. Please forward it to them\.\n\nhttps?:\/\/\S+\/play\/f\/\S+\n\n/ }]);
    expect(r.sent[0].text.endsWith(HOW)).toBe(true);
    expect(linksIn(r.sent[0].text)).toHaveLength(1);
    expect(await fnf.group.counts()).toMatchObject({ confirmed: 2, bench: 0 });
    expect(await pool.db.one(`SELECT id FROM "User" WHERE name = 'Ali'`)).toBeNull();
    const rows = await friendLinkRows(pool, fnf.group.orgId);
    expect(rows).toMatchObject([{ friendName: "Ali", issuedByUserId: fnf.group.player("shane").userId, usedAt: null }]);
  });

  scenario("an unnamed friend (+1, my brother): ✉️, a link with no name, and no name question", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const r = await say(pool, fnf, "shane", "+1", unnamedFriend("+1"), { route: "offer" });
    expect(r.react).toBe("✉️");
    pool.expectSent(r.sent, [{ to: "fnf.shane", channel: "dm", text: /^Here's the link for your friend to join \*FNF\*.*Please forward it to them\./ }]);
    expect(r.reply).toBeNull();

    const r2 = await say(pool, fnf, "dan", "my brother can play if needed", unnamedFriend("my brother", "relation"), { route: "offer" });
    expect(r2.react).toBe("✉️");
    pool.expectSent(r2.sent, [{ to: "fnf.dan", channel: "dm", text: /link for your friend/ }]);
    expect(await fnf.group.counts()).toMatchObject({ confirmed: 2, bench: 0 });
  });

  scenario("two friends in one message: one DM with two numbered links", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const two = facts([
      claim({ subject: "other", personRef: "Ali", personNamed: true, personKind: "named", polarity: "in" }),
      claim({ subject: "other", personRef: "my cousin", personNamed: false, personKind: "relation", polarity: "in" }),
    ]);
    const r = await say(pool, fnf, "shane", "Ali and my cousin are in", two);
    expect(r.react).toBe("✉️");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].text).toMatch(/Each friend needs their own link\.\n\n1\. Ali: \S+\/play\/f\/\S+\n2\. Friend: \S+\/play\/f\/\S+/);
    expect(await friendLinkRows(pool, fnf.group.orgId)).toHaveLength(2);
  });

  scenario("a full squad still gets the link (he goes on the bench when he books)", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { maxPlayers: 2, confirmed: ["owner", "dan"] });
    const r = await say(pool, fnf, "shane", "my friend Ali is in", namedFriend("Ali"));
    expect(r.react).toBe("✉️");
    expect(r.sent).toHaveLength(1);
  });

  scenario("the same group message delivered twice: one DM, one link", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const id = `wamid.friend-dup-${Date.now()}`;
    const r1 = await say(pool, fnf, "shane", "my friend Ali is in", namedFriend("Ali"), { waMessageId: id });
    expect(r1.sent).toHaveLength(1);
    const r2 = await say(pool, fnf, "shane", "my friend Ali is in", namedFriend("Ali"), { waMessageId: id });
    expect(r2.sent.filter((m) => m.channel === "dm")).toEqual([]);
    expect(await friendLinkRows(pool, fnf.group.orgId)).toHaveLength(1);
  });

  scenario("the cap: a fourth unused link is not made; his three unused links are sent again", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    for (const n of ["Ali", "Mehmet", "Can"]) {
      const r = await say(pool, fnf, "shane", `my friend ${n} is in`, namedFriend(n));
      expect(r.sent).toHaveLength(1);
    }
    const r = await say(pool, fnf, "shane", "my friend Deniz is in", namedFriend("Deniz"));
    expect(r.react).toBe("✉️");
    pool.expectSent(r.sent, [{ to: "fnf.shane", channel: "dm", text: /^You already have links for \*FNF\* on .* that nobody has used yet, so here they are again:\n\n1\. Ali: \S+\n2\. Mehmet: \S+\n3\. Can: \S+/ }]);
    expect((await friendLinkRows(pool, fnf.group.orgId)).map((x) => x.friendName)).toEqual(["Ali", "Mehmet", "Can"]);
  });

  scenario("a player with no number on record: no ✉️, one line in the group, nothing written", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const r = await say(pool, fnf, "gary", "+1", unnamedFriend("+1"), { route: "offer" });
    expect(r.react).toBeNull();
    pool.expectSent(r.sent, [{ to: "fnf.group", text: "Gary, I couldn't DM you the link for your friend. Message me privately once and tag me here again." }]);
    expect(await friendLinkRows(pool, fnf.group.orgId)).toEqual([]);
  });

  scenario("no upcoming match: nothing sent, nothing said", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf", { upcomingMatch: false, confirmed: [] });
    const r = await say(pool, fnf, "shane", "+1", unnamedFriend("+1"), { route: "offer" });
    expect(r.react).toBeNull();
    expect(r.sent).toEqual([]);
  });

  scenario("a Turkish club: the DM in Turkish", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [fnf.group.orgId]);
    const r = await say(pool, fnf, "shane", "arkadaşım Ali geliyor", namedFriend("Ali"));
    pool.expectSent(r.sent, [{ to: "fnf.shane", channel: "dm", text: /^Ali için \*FNF\* ile .* maçının bağlantısı aşağıda\. Lütfen ona ilet\./ }]);
  });

  scenario("an organiser's 'Mehmet is in' still adds Mehmet directly (D1)", async ({ pool }) => {
    const fnf = await friendClub(pool, "fnf");
    const r = await say(pool, fnf, "alice", "Mehmet is in", otherFacts("Mehmet", "in", { personKind: "named" }));
    expect(r.react).not.toBe("✉️");
    expect(await friendLinkRows(pool, fnf.group.orgId)).toEqual([]);
    expect(await pool.db.one(`SELECT u.id FROM "User" u JOIN "Attendance" a ON a."userId" = u.id WHERE u.name = 'Mehmet' AND a."matchId" = $1`, [fnf.group.matchId])).not.toBeNull();
  });
});
