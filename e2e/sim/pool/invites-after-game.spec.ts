/**
 * POOL SCENARIOS: joining a club's group after a game (slice L8, 2026-10-24).
 * Approved spec, "Joining the group": after the game the guest is asked
 * privately, then the organisers (in HQ, or by the club's admin DM with no
 * HQ, decision L8.4); only on both yeses does the invite link go to him,
 * and to nobody else. Model-free ($0): every answer is a tap.
 *
 *   both yes (pasted link): asked, Join, the organisers told, Send the
 *   invite link, the link to him only, he joins the group and is a member
 *   he says no thanks: closed, nobody told, the card greyed
 *   the club says not now: he hears once, kindly, no link
 *   the club never answers: after 7 days withdrawn, he hears once
 *   source A: MatchTime is a group admin, the Pi reads the code; the Pi
 *   fails and there is no pasted link: the organisers are told
 *   no link set up: the organisers are told how; the card is greyed
 *   a stopped profile, a guest who did not play, asked once only
 *   a partner club's guest is never asked automatically (Invite to club
 *   only); Turkish; the link taken back or replaced before it went; a
 *   stop after his yes; Join from someone already a member
 */
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import { openClub } from "./offers-world";
import {
  PASTED,
  PI_CODE,
  botIsGroupAdmin,
  browserOf,
  invitationsOf,
  joinsGroup,
  linkIn,
  membershipOf,
  openAndAnswer,
  organiserTaps,
  pasteLink,
  piPolls,
  playedGuest,
} from "./invites-world";
import type { SentMessage } from "./transcript";

const DAY = 24 * 3600_000;
const linkLeaks = (sent: readonly SentMessage[], allowedTo: string, link: string) =>
  sent.filter((m) => m.text.includes(link) && !(m.to === allowedTo && m.purpose === "club-invite-link"));

scenarios("after the game: joining the club's group", () => {
  scenario("both say yes (pasted link): the link goes to him only, and joining makes him a member", async ({ pool, browser }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    await pasteLink(pool, fnf);
    const sam = await playedGuest(pool, fnf, "sam", { name: "Sam Kerr" });

    const { queued } = await piPolls(pool);
    pool.expectSent(queued, [
      { to: "sam", channel: "dm", purpose: "club-invite-ask", text: /^Enjoyed the game with \*FNF\* on .+\? Want to join their group for future games\? Answer here: https?:\/\/\S+\/r\/\S+$/ },
    ]);
    pool.expectNoLeaks(fnf.secrets(), { to: ["sam"] });

    const guest = await browserOf(browser);
    expect(await openAndAnswer(pool, guest, linkIn(queued[0]), "join", "sam")).toBe("waiting-club");
    const told = await pool.collect();
    pool.expectSent(told, [{ to: "fnf.hq", channel: "hq", text: /^🙋 Sam K played with you on .+ as a guest and wants to join your group\. To send them the group's invite link, tap Send the invite link on their card: \S+\/admin\/guests\?tab=history$/ }]);
    pool.expectNoLeaks(sam.phoneVariants(), { to: ["fnf.hq"] });

    const owner = await browserOf(browser);
    await organiserTaps(pool, owner, fnf, "send");
    const link = await pool.collect();
    pool.expectSent(link, [{ to: "sam", channel: "dm", purpose: "club-invite-link", text: `Join their WhatsApp group here: ${PASTED}` }]);
    expect(linkLeaks(pool.sent, "sam", PASTED)).toEqual([]);
    expect(await invitationsOf(pool, fnf, sam)).toMatchObject([{ status: "accepted", origin: "after-game", linkSentAt: expect.any(Date) }]);

    pool.note("he taps the link and joins the WhatsApp group");
    await joinsGroup(pool, fnf, sam);
    expect(await membershipOf(pool, fnf, sam)).toEqual({ role: "PLAYER", guestVia: null, guestMatchId: null, leftAt: null });
    const joined = await pool.collect();
    expect(joined.map((m) => m.to)).toEqual(["fnf.hq"]);
    pool.expectNoLeaks([PASTED], { in: joined });

    pool.note("the next poll asks nothing again");
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("he says no thanks: closed, nobody told, the card greyed", async ({ pool, browser }) => {
    const ham = await openClub(pool, "ham", { name: "Hammers", hq: true });
    await pasteLink(pool, ham);
    const ali = await playedGuest(pool, ham, "ali", { name: "Ali Kaya" });
    const { queued } = await piPolls(pool);
    expect(await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "no", "ali")).toBe("declined");
    pool.expectSent(await pool.collect(), []);
    expect(await invitationsOf(pool, ham, ali)).toMatchObject([{ status: "declined", declinedBy: "player", linkSentAt: null }]);

    const owner = await browserOf(browser);
    const o = await pool.userOf(ham.member("owner"));
    await signInAs(owner, o!.id, "/admin/guests?tab=history");
    await owner.goto("/admin/guests?tab=history");
    await owner.getByTestId("guest-card-open").first().click();
    await expect(owner.getByTestId("guest-invite")).toBeDisabled();
    await expect(owner.getByTestId("guest-invite-declined")).toBeVisible();
  });

  scenario("the club says not now: he hears once, kindly, and never gets the link", async ({ pool, browser }) => {
    const wol = await openClub(pool, "wol", { name: "Wolves", hq: true });
    await pasteLink(pool, wol);
    const ben = await playedGuest(pool, wol, "ben", { name: "Ben Tor" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "ben");
    await pool.collect();
    await organiserTaps(pool, await browserOf(browser), wol, "not-now");
    pool.expectSent(await pool.collect(), [{ to: "ben", purpose: "club-invite-closed", text: /^Thanks for saying yes\. \*Wolves\* is not adding new players to their group right now\./ }]);
    expect(await invitationsOf(pool, wol, ben)).toMatchObject([{ status: "declined", declinedBy: "club", linkSentAt: null }]);
    expect(pool.sent.filter((m) => m.text.includes(PASTED))).toEqual([]);
  });

  scenario("the club never answers: withdrawn after 7 days, he hears once", async ({ pool, browser }) => {
    const ars = await openClub(pool, "ars", { name: "Arsenal Vets", hq: true });
    await pasteLink(pool, ars);
    const cal = await playedGuest(pool, ars, "cal", { name: "Cal Moss" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "cal");
    await pool.collect();

    pool.expectSent((await piPolls(pool, { now: new Date(Date.now() + 6 * DAY) })).queued, []);
    const later = await piPolls(pool, { now: new Date(Date.now() + 7 * DAY + 60_000) });
    pool.expectSent(later.queued, [{ to: "cal", purpose: "club-invite-closed", text: "Arsenal Vets" }]);
    expect(await invitationsOf(pool, ars, cal)).toMatchObject([{ status: "withdrawn", linkSentAt: null }]);
    pool.expectSent((await piPolls(pool, { now: new Date(Date.now() + 8 * DAY) })).queued, []);
  });

  scenario("source A: MatchTime is a group admin, the Pi reads the group's code and the link goes to him", async ({ pool, browser }) => {
    const che = await openClub(pool, "che", { name: "Chelsea Sunday", hq: true });
    await botIsGroupAdmin(pool, che);
    const dan = await playedGuest(pool, che, "dan", { name: "Dan Lee" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "dan");
    pool.expectSent(await pool.collect(), [{ to: "che.hq", text: /wants to join your group/ }]);
    await organiserTaps(pool, await browserOf(browser), che, "send");
    const ask = await pool.collect();
    expect(ask.map((m) => [m.channel, m.purpose, m.text])).toEqual([["action", "invite-code", ""]]);

    const poll = await piPolls(pool, { code: PI_CODE });
    expect(poll.jobs.map((j) => j.kind)).toEqual(["invite-code"]);
    const link = await pool.collect();
    pool.expectSent(link, [{ to: "dan", purpose: "club-invite-link", text: `https://chat.whatsapp.com/${PI_CODE}` }]);
    expect(linkLeaks(pool.sent, "dan", PI_CODE)).toEqual([]);
  });

  scenario("source A fails and nothing is pasted: the organisers are told how, and the paste then sends it", async ({ pool, browser, page }) => {
    const tot = await openClub(pool, "tot", { name: "Spurs Lads", hq: true });
    await botIsGroupAdmin(pool, tot);
    const eli = await playedGuest(pool, tot, "eli", { name: "Eli Ward" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "eli");
    await pool.collect();
    await organiserTaps(pool, await browserOf(browser), tot, "send");
    await pool.collect();
    await piPolls(pool, { code: null });
    pool.expectSent(await pool.collect(), [{ to: "tot.hq", text: /^I could not get your group's invite link for Eli W\. Paste the link in Settings and I'll send it to them: \S+\/admin\/settings#group-invite-link$/ }]);

    pool.note("an organiser pastes the link on the settings page");
    const o = await pool.userOf(tot.member("owner"));
    await signInAs(page, o!.id, "/admin/settings");
    await page.goto("/admin/settings#group-invite-link");
    await page.getByTestId("group-invite-link-input").fill(PASTED);
    await page.getByTestId("group-invite-link-save").click();
    await expect(page.getByTestId("group-invite-link-remove")).toBeVisible({ timeout: 45_000 });
    pool.expectSent(await pool.collect(), [{ to: "eli", purpose: "club-invite-link", text: PASTED }]);
  });

  scenario("no link set up: the organisers are told how, and the card is greyed until there is one", async ({ pool, browser }) => {
    const lut = await openClub(pool, "lut", { name: "Luton Fives", hq: true });
    const fay = await playedGuest(pool, lut, "fay", { name: "Fay Hart" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "fay");
    const told = await pool.collect();
    expect(told).toHaveLength(1);
    expect(told[0].text).toMatch(/wants to join your group/);
    expect(told[0].text).toMatch(/make MatchTime an admin of your WhatsApp group, or paste the link in Settings: \S+\/admin\/settings#group-invite-link$/);

    const owner = await browserOf(browser);
    const o = await pool.userOf(lut.member("owner"));
    await signInAs(owner, o!.id, "/admin/guests?tab=history");
    await owner.goto("/admin/guests?tab=history");
    await owner.getByTestId("guest-card-open").first().click();
    await expect(owner.getByTestId("guest-invite-send")).toBeDisabled();
    await expect(owner.getByTestId("guest-invite-no-link")).toContainText("paste your group's invite link in Settings");
    expect(await invitationsOf(pool, lut, fay)).toMatchObject([{ status: "open", clubYesAt: null }]);
  });

  scenario("never asked: a stopped profile, a guest who did not play; and nobody is asked twice", async ({ pool }) => {
    const bur = await openClub(pool, "bur", { name: "Burnley Sunday", hq: true });
    await pasteLink(pool, bur);
    await playedGuest(pool, bur, "gus", { name: "Gus Stop", status: "stopped" });
    await playedGuest(pool, bur, "hal", { name: "Hal Drop", attendance: "DROPPED" });
    const ned = await playedGuest(pool, bur, "ned", { name: "Ned Noshow" });
    pool.note("an organiser marked Ned a no-show (slice L7): his final result");
    await pool.db.run(`UPDATE "GuestPlace" SET result = 'no-show' WHERE "userId" = $1`, [ned.userId]);
    const ivy = await playedGuest(pool, bur, "ivy", { name: "Ivy Lane", hoursAgo: 0.5 });
    pool.note("Ivy's game ended less than an hour ago: not yet");
    pool.expectSent((await piPolls(pool)).queued, []);
    pool.expectSent((await piPolls(pool, { now: new Date(Date.now() + 2 * 3600_000) })).queued, [{ to: "ivy", purpose: "club-invite-ask" }]);
    pool.expectSent((await piPolls(pool, { now: new Date(Date.now() + 3 * 3600_000) })).queued, []);
    expect(await invitationsOf(pool, bur, ivy)).toHaveLength(1);
  });

  scenario("a club with no HQ: the organisers hear by their admin DM, with a signed link to the card", async ({ pool, browser }) => {
    const ful = await openClub(pool, "ful", { name: "Fulham Fives" });
    await pasteLink(pool, ful);
    const jay = await playedGuest(pool, ful, "jay", { name: "Jay Cole" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "jay");
    const told = await pool.collect();
    expect(told.length).toBeGreaterThan(0);
    for (const m of told) {
      expect(m.channel).toBe("dm");
      expect(m.to).toMatch(/^ful\./);
      expect(m.text).toMatch(/^🙋 Jay C played with you on .+ wants to join your group\. .*https?:\/\/\S+\/r\/\S+$/);
    }
    pool.expectNoLeaks([...jay.phoneVariants(), PASTED], { in: told });
  });

  scenario("a partner club's guest is never asked automatically (only a deliberate Invite to club recruits him)", async ({ pool }) => {
    const ev = await pool.club("ev", { name: "Erdal Vets" });
    const gal = await openClub(pool, "gal", { name: "Galata FC", hq: true });
    await pasteLink(pool, gal);
    const pete = await playedGuest(pool, gal, "pete", { via: "partner", partner: ev });
    pool.expectSent((await piPolls(pool)).queued, []);
    expect(await invitationsOf(pool, gal, pete)).toEqual([]);
  });

  scenario("a Turkish club: the pool guest asked in his Turkish, the organisers told in Turkish", async ({ pool, browser }) => {
    const kad = await openClub(pool, "kad", { name: "Moda FC", hq: true });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [kad.group.orgId]);
    await pasteLink(pool, kad);
    await playedGuest(pool, kad, "emre", { name: "Emre Sahin", lang: "tr" });
    const { queued } = await piPolls(pool);
    pool.expectSent(queued, [{ to: "emre", purpose: "club-invite-ask", text: /günü \*Moda FC\* ile oynadığın maç güzel geçti mi\? .*Buradan yanıtla: / }]);
    pool.expectNoLeaks(kad.secrets(), { to: ["emre"] });
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "emre");
    pool.expectSent(await pool.collect(), [{ to: "kad.hq", text: /misafir olarak oynadı ve grubunuza katılmak istiyor\. .*Davet bağlantısını gönder düğmesine dokunun/ }]);
  });

  scenario("the club takes its link back before the DM went: cancelled, the card says approved; once MatchTime is admin the Pi's link goes", async ({ pool, browser, page }) => {
    const new1 = await openClub(pool, "new1", { name: "Newham Weds", hq: true });
    await pasteLink(pool, new1);
    const kai = await playedGuest(pool, new1, "kai", { name: "Kai Moon" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "kai");
    await pool.collect();
    await organiserTaps(pool, await browserOf(browser), new1, "send");
    const link = await pool.collect();
    pool.expectSent(link, [{ to: "kai", purpose: "club-invite-link", text: PASTED }]);

    pool.note("before the Pi takes it, an organiser removes the link on the settings page");
    const o = await pool.userOf(new1.member("owner"));
    await signInAs(page, o!.id, "/admin/settings");
    await page.goto("/admin/settings#group-invite-link");
    await page.getByTestId("group-invite-link-remove").click();
    await expect(page.getByTestId("group-invite-link")).toHaveAttribute("data-mode", "none", { timeout: 45_000 });
    expect(await pool.db.one(`SELECT status FROM "PlatformJob" WHERE id = $1`, [link[0].id])).toEqual({ status: "failed" });
    expect(await invitationsOf(pool, new1, kai)).toMatchObject([{ status: "accepted", linkSentAt: null }]);
    await page.goto("/admin/guests?tab=history");
    await page.getByTestId("guest-card-open").first().click();
    await expect(page.getByTestId("guest-invite-approved")).toHaveText("Approved, waiting for the group link.");
    pool.expectSent((await piPolls(pool)).queued, []);

    pool.note("MatchTime is made an admin of the group: the next poll gets the link from the Pi");
    await botIsGroupAdmin(pool, new1);
    const poll = await piPolls(pool, { code: PI_CODE });
    expect(poll.jobs.map((j) => j.kind)).toEqual(["invite-code"]);
    pool.expectSent(await pool.collect(), [{ to: "kai", purpose: "club-invite-link", text: `https://chat.whatsapp.com/${PI_CODE}` }]);
    expect(linkLeaks(pool.sent, "kai", PI_CODE)).toEqual([]);
  });

  scenario("the club replaces its link before the DM went: the old one is taken back, the new one goes", async ({ pool, browser, page }) => {
    const rep = await openClub(pool, "rep", { name: "Redbridge Mon", hq: true });
    await pasteLink(pool, rep);
    await playedGuest(pool, rep, "lou", { name: "Lou Park" });
    const { queued } = await piPolls(pool);
    await openAndAnswer(pool, await browserOf(browser), linkIn(queued[0]), "join", "lou");
    await pool.collect();
    await organiserTaps(pool, await browserOf(browser), rep, "send");
    const old = await pool.collect();
    const NEW = "https://chat.whatsapp.com/NewL1nkZyXwVuTsRq9876";
    const o = await pool.userOf(rep.member("owner"));
    await signInAs(page, o!.id, "/admin/settings");
    await page.goto("/admin/settings#group-invite-link");
    await page.getByTestId("group-invite-link-input").fill(NEW);
    await page.getByTestId("group-invite-link-save").click();
    await expect(page.getByTestId("group-invite-link-remove")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/^Saved\. MatchTime sends it only/)).toBeVisible({ timeout: 30_000 });
    pool.expectSent(await pool.collect(), [{ to: "lou", purpose: "club-invite-link", text: NEW }]);
    expect(await pool.db.one(`SELECT status FROM "PlatformJob" WHERE id = $1`, [old[0].id])).toEqual({ status: "failed" });
  });

  scenario("he stops game messages after saying yes: withdrawn, no link and no closing line ever", async ({ pool, browser }) => {
    const sto = await openClub(pool, "sto", { name: "Stockwell Fri", hq: true });
    await pasteLink(pool, sto);
    const mo = await playedGuest(pool, sto, "mo", { name: "Mo Ali" });
    const { queued } = await piPolls(pool);
    const guest = await browserOf(browser);
    await openAndAnswer(pool, guest, linkIn(queued[0]), "join", "mo");
    await pool.collect();
    pool.note("he stops MatchTime's game messages on his manage page");
    await guest.goto("/play/manage");
    await guest.getByRole("button", { name: "Stop game messages" }).click();
    await expect(guest.getByTestId("pool-status")).toContainText(/stopped/i, { timeout: 20_000 });
    expect(await invitationsOf(pool, sto, mo)).toMatchObject([{ status: "withdrawn", linkSentAt: null }]);
    // (Earlier scenarios' unanswered invitations expire in this poll; none is his.)
    expect((await piPolls(pool, { now: new Date(Date.now() + 8 * DAY) })).queued.filter((m) => m.to === "mo")).toEqual([]);
    const o = await pool.userOf(sto.member("owner"));
    const owner = await browserOf(browser);
    await signInAs(owner, o!.id, "/admin/guests?tab=history");
    await owner.goto("/admin/guests?tab=history");
    await owner.getByTestId("guest-card-open").first().click();
    await expect(owner.getByTestId("guest-invite")).toBeDisabled();
    await expect(owner.getByTestId("guest-invite-unavailable")).toBeVisible();
    pool.expectSent(await pool.collect(), []);
  });

  scenario("he is already a member when he taps Join: refused, nothing sent", async ({ pool, browser }) => {
    const mem = await openClub(pool, "mem", { name: "Merton Tue", hq: true });
    await pasteLink(pool, mem);
    const nia = await playedGuest(pool, mem, "nia", { name: "Nia Bell" });
    const { queued } = await piPolls(pool);
    const guest = await browserOf(browser);
    await guest.goto(linkIn(queued[0]));
    await guest.waitForURL(/\/play\/invitations/);
    pool.note("while his page is open, an organiser adds him to the club another way");
    await pool.db.run(`UPDATE "Membership" SET "guestVia" = NULL, "guestMatchId" = NULL WHERE "orgId" = $1 AND "userId" = $2`, [mem.group.orgId, nia.userId]);
    await guest.getByTestId("my-invitation-join").click();
    await expect(guest.getByTestId("my-invitation-result")).toHaveAttribute("data-result", "member", { timeout: 20_000 });
    await expect(guest.getByTestId("my-invitation-result")).toHaveText("You are already in this club.");
    pool.note("on a reload the invitation is not listed");
    await guest.reload();
    await expect(guest.getByTestId("my-invitations-none")).toBeVisible({ timeout: 30_000 });
    pool.expectSent(await pool.collect(), []);
    expect(await invitationsOf(pool, mem, nia)).toMatchObject([{ status: "open", playerYesAt: null }]);
  });
});
