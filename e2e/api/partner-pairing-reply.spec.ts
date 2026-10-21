/**
 * /api/whatsapp/dm-reply and /api/whatsapp/reaction: A CLUB OWNER ANSWERS
 * THE PARTNER-CLUB PAIRING NOTICE IN WHATSAPP (2026-10-21).
 *
 * Kemal: "whatsapp reply like pressing 1 or 2 should also do the same
 * job". The notice says "Club owner: reply *1* to accept or *2* to
 * decline"; the reply is read by the pairing classifier (STUBBED here: it
 * stubs only what the model said) and acted on by `actOnPartnership`.
 *
 *   - one owner of BOTH clubs gets two notices; a swipe-reply to one acts on
 *     that club's side only;
 *   - an unquoted "yes" with both waiting asks which, and changes nothing;
 *   - a ✅ reaction on the other notice accepts that side: the pairing is
 *     active;
 *   - a "2" quoting a notice declines; somebody who is not the owner gets
 *     the owner-only line; a reply that is not an answer falls through.
 *
 * Free: no model is called.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPairingReplyStub, setPairingReplyStub, stubCalls } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

const TWO = "e2e-pair-two";
const PAIR = "e2e-pair-p1";
const digits = (p: string) => p.replace(/^\+/, "");

test.beforeEach(() => {
  resetDb();
  clearPairingReplyStub();
});
test.afterAll(() => clearPairingReplyStub());

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-pair-${Date.now()}-${++n}`, authorName: null, ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The second club, owned by the same person (Alex Admin), and the pairing
 *  e2e-org may ask it, proposed. */
async function pairing(db: TestDb) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", "setupStage", "createdAt", "updatedAt")
     VALUES ($1, 'Two FC', $1, $2, 'approved', 'live', now(), now())`,
    [TWO, `${TWO}-invite`],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ('e2e-pair-m', $1, $2, 'OWNER', now())`, [U.admin, TWO]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'proposed', $4, now(), now())`,
    [PAIR, ORG_ID, TWO, U.admin],
  );
}

/** One club's notice, DMed and acked: the BotJob with its aboutKey, and
 *  its ack row with the stanza id a quote or a reaction carries. */
async function notice(db: TestDb, orgId: string, phone: string, minsAgo: number): Promise<{ stanza: string; waMessageId: string }> {
  const id = `e2e-pair-job-${orgId}-${++n}`;
  const stanza = `3EB0PAIR${n}${Date.now()}`;
  const waMessageId = `true_${digits(phone)}@s.whatsapp.net_${stanza}`;
  const text = "🤝 MatchTime has paired ... Club owner: reply *1* to accept or *2* to decline, or open https://x";
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "aboutKey", "createdAt", "sentAt")
     VALUES ($1, $2, 'dm', $3, $4, $5, NOW() - ($6 || ' minutes')::interval, NOW() - ($6 || ' minutes')::interval)`,
    [id, orgId, digits(phone), text, `pairing:${PAIR}:${orgId}`, String(minsAgo)],
  );
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "waStanzaId", "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, NOW() - ($5 || ' minutes')::interval)`,
    [`sn-${id}`, `botjob-${id}`, waMessageId, stanza, String(minsAgo)],
  );
  return { stanza, waMessageId };
}

const row = (db: TestDb) =>
  db.one<{ status: string; askerAcceptedAt: Date | null; partnerAcceptedAt: Date | null }>(
    `SELECT status, "askerAcceptedAt", "partnerAcceptedAt" FROM "ClubPartnership" WHERE id = $1`,
    [PAIR],
  );
const acks = (db: TestDb, phone: string) =>
  db.all<{ orgId: string; text: string }>(
    `SELECT "orgId", text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND "aboutKey" IS NULL ORDER BY "createdAt" ASC`,
    [digits(phone)],
  );

test("one owner of both clubs: a swipe-reply '1' to the asking club's notice accepts that side only, the model is shown the notice", async ({ request, db }) => {
  await pairing(db);
  const mine = await notice(db, ORG_ID, PHONE.admin, 5);
  await notice(db, TWO, PHONE.admin, 5);
  setPairingReplyStub({ bodies: { "1": "accept" } });
  const r = await postDm(request, PHONE.admin, "1", { quotedMessageId: mine.stanza, quotedText: "🤝 MatchTime has paired ...", quotedFromMatchTime: true });
  expect(r).toMatchObject({ handled: "pairing-reply", outcome: "pairing-accepted" });
  const p = await row(db);
  expect(p?.status).toBe("proposed");
  expect(p?.askerAcceptedAt).not.toBeNull();
  expect(p?.partnerAcceptedAt).toBeNull();
  const sent = await acks(db, PHONE.admin);
  expect(sent.at(-1)?.text).toMatch(/^✅ Accepted for \*.+\*\. Waiting for Two FC's owner to accept too\.$/);
  expect(sent.at(-1)?.orgId).toBe(ORG_ID);
  const turns = stubCalls(E2E.PAIRING_REPLY_STUB_FILE).filter((c) => c.label === "pairing-reply");
  expect(turns).toHaveLength(1);
  expect(turns[0].user).toContain("THEY ARE REPLYING TO MatchTime's message");
  expect(turns[0].user).toContain("paired with Two FC");
});

test("unquoted 'yes' with both notices waiting: asks which, nothing changes", async ({ request, db }) => {
  await pairing(db);
  await notice(db, ORG_ID, PHONE.admin, 6);
  await notice(db, TWO, PHONE.admin, 5);
  setPairingReplyStub({ bodies: { yes: "accept" } });
  const r = await postDm(request, PHONE.admin, "yes");
  expect(r).toMatchObject({ handled: "pairing-which" });
  const p = await row(db);
  expect(p?.askerAcceptedAt).toBeNull();
  expect(p?.partnerAcceptedAt).toBeNull();
  expect((await acks(db, PHONE.admin)).at(-1)?.text).toContain("Which pairing is that for?");
});

test("a ✅ reaction on the partner club's notice accepts that side; with the other side already in, it is active", async ({ request, db }) => {
  await pairing(db);
  await db.run(`UPDATE "ClubPartnership" SET "askerAcceptedAt" = now(), "askerAcceptedBy" = $1 WHERE id = $2`, [U.admin, PAIR]);
  const theirs = await notice(db, TWO, PHONE.admin, 5);
  const res = await request.post("/api/whatsapp/reaction", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { waMessageId: theirs.waMessageId, emoji: "✅", fromPhone: digits(PHONE.admin) },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: "pairing-reaction", outcome: "pairing-accepted" });
  expect((await row(db))?.status).toBe("active");
  const last = (await acks(db, PHONE.admin)).at(-1);
  expect(last?.text).toMatch(/^✅ Accepted\. \*Two FC\* and \*.+\* are partner clubs now\.$/);
  expect(last?.orgId).toBe(TWO);
});

test("'2' quoting a notice declines it", async ({ request, db }) => {
  await pairing(db);
  const theirs = await notice(db, TWO, PHONE.admin, 5);
  setPairingReplyStub({ bodies: { "2": "decline" } });
  const r = await postDm(request, PHONE.admin, "2", { quotedMessageId: theirs.stanza, quotedFromMatchTime: true });
  expect(r).toMatchObject({ handled: "pairing-reply", outcome: "pairing-declined" });
  expect((await row(db))?.status).toBe("ended");
  expect((await acks(db, PHONE.admin)).at(-1)?.text).toMatch(/^Declined\. \*Two FC\* won't be paired with \*.+\*\.$/);
});

test("somebody who is not the club's owner: the owner-only line, nothing changes", async ({ request, db }) => {
  await pairing(db);
  const theirs = await notice(db, ORG_ID, PHONE.collector, 5);
  setPairingReplyStub({ bodies: { "1": "accept" } });
  const r = await postDm(request, PHONE.collector, "1", { quotedMessageId: theirs.stanza, quotedFromMatchTime: true });
  expect(r).toMatchObject({ handled: "pairing-reply", outcome: "pairing-owner-only" });
  expect((await row(db))?.askerAcceptedAt).toBeNull();
  expect((await acks(db, PHONE.collector)).at(-1)?.text).toBe("Only your club's owner can accept, decline or remove a partner club.");
});

test("a reply that is not an answer falls through: nothing changes, not handled as a pairing", async ({ request, db }) => {
  await pairing(db);
  const mine = await notice(db, ORG_ID, PHONE.admin, 5);
  setPairingReplyStub({ bodies: { "what does this mean?": "neither" } });
  const r = await postDm(request, PHONE.admin, "what does this mean?", { quotedMessageId: mine.stanza, quotedFromMatchTime: true });
  expect(r.handled).not.toBe("pairing-reply");
  expect((await row(db))?.askerAcceptedAt).toBeNull();
});
