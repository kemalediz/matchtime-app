/**
 * POOL SCENARIOS: a club member opts in from his own profile (slice L3,
 * 2026-10-24). He uses the real /profile card in a browser, signed in as
 * himself, then talks to MatchTime on WhatsApp through the real Pi route.
 * Model-free (help is deterministic; the confirm handler never calls a
 * model): $0.
 *
 *   - a member with a number joins from the card: active at once, nothing is
 *     sent to anyone, his club is untouched; his "help" DM is answered as
 *     before; he stops on the manage page; the consent record holds both
 *   - a member with NO number: the WhatsApp step. The message from a number
 *     no account holds attaches NOTHING: that number hears only that the
 *     sign-up continues in the app; his signed-in card asks "a number ending
 *     NNNN messaged us with your code: is this your number?". Yes: the
 *     number and the profile become his, one welcome (Turkish club).
 *   - a friend he forwarded the code to sends it; he says No: nothing is
 *     attached, the code dies, the friend hears nothing more (not even when
 *     he sends it again), and no account is made for the friend
 *   - his code sent from a number another account holds: refused with one
 *     neutral line naming nobody, counted against that number, the code
 *     dies; a member's sign-up only ever ends on HIS account
 */
import type { Page } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { scenario, scenarios, expect } from "./fixtures";
import type { PoolClub, PoolWorld } from "./world";

const EN = poolPageCopy("en");

/** The club plays at a pitch whose address holds a postcode, so the card's
 *  postcode area (SM1) comes from it. */
async function atPitch(pool: PoolWorld, club: PoolClub, name: string): Promise<string> {
  const id = `sim-pitch-${club.group.orgId}`;
  await pool.db.run(
    `INSERT INTO "Venue" (id, "placeId", name, "formattedAddress", lat, lng, source, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Pitch Lane, Sutton SM1 1AA, UK', 51.365, -0.196, 'google', now(), now())`,
    [id, `ChIJ_${id}`, name],
  );
  await pool.db.run(`UPDATE "Activity" SET "venueId" = $1 WHERE id = $2`, [id, club.group.activityId]);
  return id;
}

/** Open the card on his profile and fill in the two ticks. */
async function openAndTick(page: Page, userId: string) {
  const copy = EN;
  await signInAs(page, userId, "/profile");
  const card = page.getByTestId("play-elsewhere");
  await expect(card.getByRole("heading", { name: copy.member.heading })).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: copy.member.open }).click();
  await card.getByRole("checkbox", { name: copy.signup.adultLabel }).check();
  await card.getByRole("checkbox", { name: copy.signup.consentLabel }).check();
  return card;
}

scenarios("a club member opts in from his profile", () => {
  scenario("with a number: active at once, nobody messaged; help as before; then he stops", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football", hq: true });
    await atPitch(pool, fnf, "Riverside Sports Centre");
    const pete = fnf.member("pete");
    const user = await pool.userOf(pete);
    const before = await pool.db.count(`SELECT count(*) FROM "Membership" WHERE "userId" = $1 AND "leftAt" IS NULL`, [user!.id]);

    const card = await openAndTick(page, user!.id);
    await expect(card.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveValue("Pete P");
    await expect(card.getByLabel(EN.fields.districtLabel, { exact: true })).toHaveValue("SM1");
    await card.getByRole("button", { name: EN.member.join }).click();
    await expect(card.getByTestId("play-elsewhere-status")).toHaveText(EN.manage.status.active);

    expect(await pool.profileOf(pete)).toMatchObject({ status: "active", source: "profile", consentChannel: "web", areaDistrict: "SM1" });
    pool.note("joining on the page sends nothing, to him or anyone");
    pool.expectSent(await pool.collect(), []);
    expect(await pool.db.count(`SELECT count(*) FROM "Membership" WHERE "userId" = $1 AND "leftAt" IS NULL`, [user!.id])).toBe(before);

    pool.note("his club DMs are unchanged: help is answered privately, as before");
    const help = await pete.dm("help");
    pool.expectSent(help.sent, [{ to: "fnf.pete", channel: "dm", text: /help/i }]);

    pool.note("he stops game messages on the manage page the card links to");
    await card.getByRole("link", { name: EN.member.manageLink }).click();
    await page.waitForURL("**/play/manage");
    await page.getByRole("button", { name: EN.manage.stop }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.stopped);
    expect(await pool.profileOf(pete)).toMatchObject({ status: "stopped" });
    expect(await pool.consentRecords(user!.id)).toEqual([
      { action: "consent", channel: "web" },
      { action: "withdraw", channel: "web" },
    ]);

    pool.note("a message from him afterwards is his club's business, not the pool's");
    const after = await pete.dm("thanks");
    expect(after.json.handled).not.toBe("pool-confirm");
    pool.expectSent(pool.sent.filter((m) => m.purpose?.startsWith("pool-")), []);
  });

  scenario("no number (Turkish club): nothing attached until he says Yes on his page; then the number and the profile are his", async ({ pool, page }) => {
    const ist = await pool.club("ist", {
      name: "Cuma Futbolu",
      players: [
        { key: "owner", name: "Osman Sahip", role: "OWNER" },
        { key: "gary", name: "Gary Guest", hasPhone: false },
      ],
    });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ist.group.orgId]);
    await atPitch(pool, ist, "Sahil Halı Saha");
    const garyId = ist.group.player("gary").userId;

    pool.note("his browser is English, so the page is; his club speaks Turkish, so his messages are");
    const card = await openAndTick(page, garyId);
    await expect(card.getByText(EN.member.whatsAppNote)).toBeVisible();
    await card.getByRole("button", { name: EN.member.continueWhatsApp }).click();
    const prefill = (await card.getByTestId("pool-prefill").innerText()).trim();
    expect(prefill).toMatch(/^Merhaba MatchTime, oynamak için kaydet\. Kod [A-Z2-9]{5}$/);
    pool.expectSent(await pool.collect(), []);

    pool.note("he sends it from his own WhatsApp: a number no account holds");
    const phone = await pool.stranger("gary-phone", { name: "Gary" });
    const ex = await phone.dm(prefill);
    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "claim-recorded" });
    pool.expectSent(ex.sent, [{ to: "gary-phone", purpose: "pool-code-reply", text: /^Teşekkürler\. Bu kayıt MatchTime uygulamasında devam ediyor/ }]);
    pool.expectNoLeaks([...ist.secrets(), "Gary Guest", "Cuma Futbolu"], { to: ["gary-phone"] });
    expect(await pool.db.one(`SELECT "phoneNumber" FROM "User" WHERE id = $1`, [garyId])).toEqual({ phoneNumber: null });
    expect(await pool.userOf(phone)).toBeNull();
    expect(await pool.consentRecords(garyId)).toEqual([]);

    pool.note("the same message again (a Pi retry) is silent");
    pool.expectSent((await phone.dm(prefill, { messageId: ex.messageId })).sent, []);

    pool.note("on his page: is this your number?");
    await page.reload();
    const claim = page.getByTestId("play-elsewhere-claim");
    await expect(claim.getByText(EN.member.claimQuestion(phone.phone.slice(-4)))).toBeVisible();
    await expect(page.getByTestId("play-elsewhere")).not.toContainText(phone.phone.slice(1, -4));
    await claim.getByRole("button", { name: EN.member.claimYes }).click();
    await expect(page.getByTestId("play-elsewhere-status")).toHaveText(EN.manage.status.active);

    expect(await pool.db.one(`SELECT "phoneNumber" FROM "User" WHERE id = $1`, [garyId])).toEqual({ phoneNumber: phone.phone });
    expect(await pool.profileOf(phone)).toMatchObject({ userId: garyId, status: "active", source: "profile", consentChannel: "whatsapp", claimPhone: null, language: "tr" });
    expect(await pool.consentRecords(garyId)).toEqual([{ action: "consent", channel: "whatsapp" }]);
    pool.expectSent(await pool.collect(), [{ to: "gary-phone", purpose: "pool-welcome", text: /oyuncu havuzu/i }]);
  });

  scenario("a friend sends his forwarded code; he says No: nothing attached, the code dies, the friend hears nothing more", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", {
      name: "Friday Night Football",
      players: [
        { key: "owner", name: "Oscar Owner", role: "OWNER" },
        { key: "gary", name: "Gary Guest", hasPhone: false },
      ],
    });
    await atPitch(pool, fnf, "Riverside Sports Centre");
    const garyId = fnf.group.player("gary").userId;
    const card = await openAndTick(page, garyId);
    await card.getByRole("button", { name: EN.member.continueWhatsApp }).click();
    const prefill = (await card.getByTestId("pool-prefill").innerText()).trim();

    pool.note("Gary forwards the message; his friend Fred sends it from his own phone");
    const fred = await pool.stranger("fred", { name: "Fred" });
    const ex = await fred.dm(prefill);
    expect(ex.json).toMatchObject({ result: "claim-recorded" });
    pool.expectSent(ex.sent, [{ to: "fred", purpose: "pool-code-reply", text: /^Thanks\. This sign-up continues in the MatchTime app/ }]);
    pool.expectNoLeaks([...fnf.secrets(), "Gary", "Friday Night Football"], { to: ["fred"] });

    await page.reload();
    const claim = page.getByTestId("play-elsewhere-claim");
    await expect(claim.getByText(EN.member.claimQuestion(fred.phone.slice(-4)))).toBeVisible();
    await claim.getByRole("button", { name: EN.member.claimNo }).click();
    await expect(page.getByTestId("play-elsewhere").getByRole("status")).toHaveText(EN.member.claimNoDone);
    await expect(page.getByTestId("play-elsewhere").getByRole("button", { name: EN.member.open })).toBeVisible();

    expect(await pool.db.one(`SELECT "phoneNumber" FROM "User" WHERE id = $1`, [garyId])).toEqual({ phoneNumber: null });
    expect(await pool.userOf(fred)).toBeNull();
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "userId" = $1 AND status <> 'pending-verify'`, [garyId])).toBe(0);
    expect(await pool.consentRecords(garyId)).toEqual([]);

    pool.note("Fred sends the code again: the code is dead and he hears nothing");
    const again = await fred.dm(prefill);
    expect(again.json).toMatchObject({ handled: "pool-confirm", result: "claim-waiting" });
    pool.expectSent(again.sent, []);
    expect(await pool.userOf(fred)).toBeNull();
    pool.expectSent(await pool.collect(), []);
  });

  scenario("his code sent from a number of ANOTHER account: refused, nothing of his reaches it, the code dies, counted", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", {
      name: "Friday Night Football",
      players: [
        { key: "owner", name: "Oscar Owner", role: "OWNER" },
        { key: "pete", name: "Pete Power" },
        { key: "gary", name: "Gary Guest", hasPhone: false },
      ],
    });
    await atPitch(pool, fnf, "Riverside Sports Centre");
    const garyId = fnf.group.player("gary").userId;
    const pete = fnf.member("pete");

    const card = await openAndTick(page, garyId);
    await card.getByRole("button", { name: EN.member.continueWhatsApp }).click();
    const prefill = (await card.getByTestId("pool-prefill").innerText()).trim();

    pool.note("Pete sends Gary's message from his own phone: Pete has an account");
    const ex = await pete.dm(prefill);
    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "not-yours" });
    pool.expectSent(ex.sent, [{ to: "fnf.pete", purpose: "pool-code-reply", text: /^Sorry, that code can't be used from this number\.$/ }]);
    pool.expectNoLeaks(["Gary", "Riverside", "Friday Night Football"], { to: ["fnf.pete"] });

    expect(await pool.profileOf(pete)).toBeNull();
    expect(await pool.failedAttempts(pete)).toBe(1);
    expect(await pool.db.one(`SELECT "phoneNumber" FROM "User" WHERE id = $1`, [garyId])).toEqual({ phoneNumber: null });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "userId" = $1 AND status <> 'pending-verify'`, [garyId])).toBe(0);
    expect(await pool.consentRecords(garyId)).toEqual([]);

    pool.note("the code is dead: Gary's card offers a fresh start, and the code sent again is only 'expired'");
    await page.reload();
    await expect(page.getByTestId("play-elsewhere").getByRole("button", { name: EN.member.open })).toBeVisible();
    const again = await pete.dm(prefill);
    expect(again.json).toMatchObject({ result: "expired" });
    expect(await pool.profileOf(pete)).toBeNull();
  });
});
