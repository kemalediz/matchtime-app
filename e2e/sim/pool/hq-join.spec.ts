/**
 * POOL SCENARIOS: a guest who played wants to join, and the organisers say
 * YES in their admin group (L10 follow-up on L8, 2026-10-25).
 *
 * L8's flow, through its own world (`invites-world.ts`): the guest played,
 * the after-game question went, he tapped Join on My invitations. Its
 * notice in HQ now invites a YES there and is logged as MatchTime's
 * question (`join-request:<invitation>`), so the safe-YES rule decides a
 * YES; the YES is the card's own "Send the invite link" (`answerAsClub`).
 * The model is STUBBED ($0): the router's "approve" is the stub's; the
 * paid check is `scripts/live-check-hq-pool.ts`.
 */
import type { Browser } from "@playwright/test";
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { openClub } from "./offers-world";
import { PASTED, browserOf, invitationsOf, linkIn, openAndAnswer, pasteLink, piPolls, playedGuest } from "./invites-world";
import type { PoolWorld, PoolClub, PoolPerson } from "./world";
import type { SentMessage } from "./transcript";
import { clearPipelineStubs, engineOn } from "../../helpers/stub";

const BIBS = "who is bringing the bibs?";
const linkDms = (ms: readonly SentMessage[]) => ms.filter((m) => m.purpose === "club-invite-link");

/** He played, was asked after the game, and tapped Join: HQ is told. */
async function wantsToJoin(pool: PoolWorld, browser: Browser, club: PoolClub, guest: PoolPerson & { userId: string }): Promise<SentMessage> {
  const { queued } = await piPolls(pool);
  const ask = queued.find((m) => m.to === guest.key && m.purpose === "club-invite-ask");
  expect(ask, "the after-game question").toBeTruthy();
  expect(await openAndAnswer(pool, await browserOf(browser), linkIn(ask!), "join", guest.key)).toBe("waiting-club");
  const told = (await pool.collect()).find((m) => m.to === `${club.key}.hq`);
  expect(told?.text).toMatch(/wants to join your group\. Say \*@Match Time YES\* here to send them the group's invite link, or tap Send the invite link on their card: \S+$/);
  return told!;
}

scenarios("a guest wants to join: the organisers' YES in HQ", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("YES sends him the link once, to him only; a second YES sends nothing", async ({ pool, browser }) => {
    stubbedOnly();
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    await pasteLink(pool, fnf);
    const sam = await playedGuest(pool, fnf, "sam", { name: "Sam Kerr" });
    pool.arm(() => engineOn({ yes: { route: "approve" } }));
    await wantsToJoin(pool, browser, fnf, sam);

    const ex = await fnf.hq.say("owner", "yes", { tagged: true });
    pool.expectSent(ex.sent, [
      { to: "fnf.hq", channel: "hq", text: "✅ Sending Sam K the players' group's invite link." },
      { to: "sam", channel: "dm", purpose: "club-invite-link", text: `Join their WhatsApp group here: ${PASTED}` },
    ]);
    expect(await invitationsOf(pool, fnf, sam)).toMatchObject([{ status: "accepted", linkSentAt: expect.any(Date) }]);
    expect(pool.sent.filter((m) => m.text.includes(PASTED) && m.to !== "sam")).toEqual([]);

    const again = await fnf.hq.say("owner", "yes", { tagged: true });
    expect(linkDms(again.sent)).toEqual([]);
    expect(linkDms(pool.sent)).toHaveLength(1);
  });

  scenario("untagged chatter while he waits stays the organisers' own, and nothing is sent", async ({ pool, browser }) => {
    stubbedOnly();
    const fnf = await openClub(pool, "chat", { name: "FNF", hq: true });
    await pasteLink(pool, fnf);
    const ali = await playedGuest(pool, fnf, "ali", { name: "Ali Kaya" });
    pool.arm(() => engineOn({ [BIBS]: { route: "none" } }));
    await wantsToJoin(pool, browser, fnf, ali);

    pool.expectSent((await fnf.hq.say("alice", BIBS)).sent, []);
    expect(await invitationsOf(pool, fnf, ali)).toMatchObject([{ status: "open", clubYesAt: null }]);
  });

  scenario("a member who is not an organiser says YES: the one line naming who can, no link", async ({ pool, browser }) => {
    stubbedOnly();
    const fnf = await openClub(pool, "np", { name: "FNF", hq: true });
    await pasteLink(pool, fnf);
    const bea = await playedGuest(pool, fnf, "bea", { name: "Bea Lane" });
    pool.arm(() => engineOn({ yes: { route: "approve" } }));
    await wantsToJoin(pool, browser, fnf, bea);

    const ex = await fnf.hq.say("pete", "yes", { tagged: true });
    pool.expectSent(ex.sent, [{ to: "np.hq", channel: "hq", text: /^Only .* can change that\.$/ }]);
    expect(linkDms(pool.sent)).toEqual([]);
    expect(await invitationsOf(pool, fnf, bea)).toMatchObject([{ status: "open", clubYesAt: null }]);
  });

  scenario("two guests waiting, a YES after talk: asks which, naming both, and sends nothing", async ({ pool, browser }) => {
    stubbedOnly();
    const fnf = await openClub(pool, "two", { name: "FNF", hq: true });
    await pasteLink(pool, fnf);
    const cem = await playedGuest(pool, fnf, "cem", { name: "Cem Yilmaz" });
    const dan = await playedGuest(pool, fnf, "dan", { name: "Dan Ward" });
    pool.arm(() => engineOn({ yes: { route: "approve" }, [BIBS]: { route: "none" } }));
    // Both asked after the game in one poll; both tap Join.
    const { queued } = await piPolls(pool);
    for (const p of [cem, dan]) {
      const ask = queued.find((m) => m.to === p.key && m.purpose === "club-invite-ask")!;
      expect(await openAndAnswer(pool, await browserOf(browser), linkIn(ask), "join", p.key)).toBe("waiting-club");
    }
    await pool.collect();
    await fnf.hq.say("alice", BIBS);

    const ex = await fnf.hq.say("owner", "yes", { tagged: true });
    pool.expectSent(ex.sent, [
      { to: "two.hq", channel: "hq", text: /^Which one is that YES for: sending (Cem Y|Dan W) the players' group's invite link, or sending (Cem Y|Dan W) the players' group's invite link\? Reply to that message with \*@Match Time YES\*\.$/ },
    ]);
    expect(ex.sent[0].text).toContain("Cem Y");
    expect(ex.sent[0].text).toContain("Dan W");
    expect(linkDms(pool.sent)).toEqual([]);
  });
});
