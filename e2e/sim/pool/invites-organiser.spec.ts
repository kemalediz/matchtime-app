/**
 * POOL SCENARIOS: "Invite to club" on the guest card (slice L8). Approved
 * spec: the organiser's tap counts as the admins' yes; MatchTime privately
 * asks the guest and sends the invite link only on his yes. Greyed out for
 * a guest who stopped messages. Only for a club with the pool on (review
 * of #406, M4); a partner club's guest only this way. Model-free ($0).
 */
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import { openClub } from "./offers-world";
import { PASTED, browserOf, invitationsOf, joinsGroup, linkIn, membershipOf, openAndAnswer, organiserTaps, pasteLink, playedGuest } from "./invites-world";

scenarios("Invite to club", () => {
  scenario("the organiser's tap asks him privately; his Join sends the link at once; joining makes him a member", async ({ pool, browser }) => {
    const sut = await openClub(pool, "sut", { name: "Sutton Sunday", hq: true });
    await pasteLink(pool, sut);
    const raj = await playedGuest(pool, sut, "raj", { name: "Raj Patel" });

    await organiserTaps(pool, await browserOf(browser), sut, "invite");
    const asked = await pool.collect();
    pool.expectSent(asked, [
      { to: "raj", channel: "dm", purpose: "club-invite-ask", text: /^\*Sutton Sunday\* would like you to join their group for future games\. Want to join\? Answer here: \S+\/r\/\S+$/ },
    ]);
    pool.expectNoLeaks(sut.secrets(), { to: ["raj"] });
    pool.expectNoLeaks([PASTED], { in: asked });
    expect(await invitationsOf(pool, sut, raj)).toMatchObject([{ status: "open", origin: "organiser", clubYesAt: expect.any(Date), playerYesAt: null }]);

    expect(await openAndAnswer(pool, await browserOf(browser), linkIn(asked[0]), "join", "raj")).toBe("link-sent");
    pool.expectSent(await pool.collect(), [{ to: "raj", purpose: "club-invite-link", text: PASTED, sendAfter: null }]);

    await joinsGroup(pool, sut, raj);
    expect(await membershipOf(pool, sut, raj)).toMatchObject({ role: "PLAYER", guestVia: null, guestMatchId: null });
  });

  scenario("a second tap, or a tap after he was invited, changes nothing", async ({ pool, browser }) => {
    const kin = await openClub(pool, "kin", { name: "Kingston Thursday", hq: true });
    await pasteLink(pool, kin);
    const zed = await playedGuest(pool, kin, "zed", { name: "Zed Ray" });
    const owner = await browserOf(browser);
    await organiserTaps(pool, owner, kin, "invite");
    await pool.collect();
    await owner.reload();
    await owner.getByTestId("guest-card-open").first().click();
    await expect(owner.getByTestId("guest-invite-invited")).toBeVisible();
    await expect(owner.getByTestId("guest-invite")).toHaveCount(0);
    pool.expectSent(await pool.collect(), []);
    expect(await invitationsOf(pool, kin, zed)).toHaveLength(1);
  });

  scenario("a guest who stopped MatchTime's messages: the button is greyed and nothing is sent", async ({ pool, page }) => {
    const ewe = await openClub(pool, "ewe", { name: "Ewell Casuals", hq: true });
    await pasteLink(pool, ewe);
    await playedGuest(pool, ewe, "sid", { name: "Sid Stop", status: "stopped" });
    const o = await pool.userOf(ewe.member("owner"));
    await signInAs(page, o!.id, "/admin/guests?tab=history");
    await page.goto("/admin/guests?tab=history");
    await page.getByTestId("guest-card-open").first().click();
    await expect(page.getByTestId("guest-invite")).toBeDisabled();
    await expect(page.getByTestId("guest-invite-unavailable")).toBeVisible();
    pool.expectSent(await pool.collect(), []);
  });

  scenario("in Turkish: the ask, My invitations and the link in his language", async ({ pool, browser }) => {
    const ist = await openClub(pool, "ist", { name: "Kadıköy FC", hq: true });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ist.group.orgId]);
    await pasteLink(pool, ist);
    await playedGuest(pool, ist, "can", { name: "Can Demir", lang: "tr" });
    await organiserTaps(pool, await browserOf(browser), ist, "invite");
    const asked = await pool.collect();
    pool.expectSent(asked, [{ to: "can", purpose: "club-invite-ask", text: /^\*Kadıköy FC\* sonraki maçlar için seni gruplarında görmek istiyor\./ }]);
    const guest = await browserOf(browser);
    await guest.goto(linkIn(asked[0]));
    await guest.waitForURL(/\/play\/invitations/);
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Davetlerim");
    await guest.getByTestId("my-invitation-join").click();
    await expect(guest.getByTestId("my-invitation-result")).toHaveText("Tamam. Davet bağlantısı WhatsApp'tan sana geliyor.");
    pool.expectSent(await pool.collect(), [{ to: "can", purpose: "club-invite-link", text: /^🎉 \*Kadıköy FC\* grubuna hoş geldin\./ }]);
  });
  scenario("a partner club's guest, deliberately: asked in his own club's Turkish, the link on his yes", async ({ pool, browser }) => {
    const ev = await pool.club("ev", { name: "Erdal Vets" });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ev.group.orgId]);
    const gal = await openClub(pool, "gal", { name: "Galata FC", hq: true });
    await pasteLink(pool, gal);
    await playedGuest(pool, gal, "pete", { via: "partner", partner: ev });
    await organiserTaps(pool, await browserOf(browser), gal, "invite");
    const asked = await pool.collect();
    pool.expectSent(asked, [{ to: "ev.pete", purpose: "club-invite-ask", text: /^\*Galata FC\* sonraki maçlar için seni gruplarında görmek istiyor\./ }]);
    pool.expectNoLeaks(gal.secrets(), { to: ["ev.pete"] });
    expect(await openAndAnswer(pool, await browserOf(browser), linkIn(asked[0]), "join", "ev.pete")).toBe("link-sent");
    pool.expectSent(await pool.collect(), [{ to: "ev.pete", purpose: "club-invite-link", text: PASTED }]);
  });
});
