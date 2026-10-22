/**
 * THE PAIRING NOTICE ANSWERED IN A CLUB'S ADMIN GROUP (2026-10-21), against
 * a real Postgres and the real /api/whatsapp/admin-group route. The shared
 * router and the pairing classifier are STUBBED (what each model would have
 * said); the rest is the shipped code: the notice found by the quoted id in
 * HQ's log, the safe-YES rule, `actOnPartnership`, and the reply.
 *
 *   - "2" swipe-replied to the notice declines it, with no router call;
 *   - an unquoted "yes" as the next message after the notice accepts this
 *     club's side;
 *   - a player of the club who replies "1" to it is refused: owners and admins only (D-2).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPairingReplyStub, clearPipelineStubs, engineOn, setPairingReplyStub } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000061@g.us";
const TWO = "e2e-hqpair-two";
const PAIR = "e2e-hqpair-p1";
const STANZA = "3EB0HQPAIR";
const NOTICE = "🤝 MatchTime has paired ... Club owner: reply to this message with *1* to accept or *2* to decline, or open https://x";
const digits = (p: string) => p.replace(/^\+/, "");

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = digits(PHONE.admin), extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-hqpair-${Date.now()}-${++seq}`, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const row = (db: TestDb) =>
  db.one<{ status: string; askerAcceptedAt: Date | null }>(`SELECT status, "askerAcceptedAt" FROM "ClubPartnership" WHERE id = $1`, [PAIR]);

test.beforeEach(async ({ db }) => {
  resetDb();
  clearPairingReplyStub();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", "createdAt", "updatedAt") VALUES ($1, 'Two FC', $1, $2, 'approved', now(), now())`,
    [TWO, `${TWO}-invite`],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "createdByUserId", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'proposed', $4, now(), now())`,
    [PAIR, ORG_ID, TWO, U.admin],
  );
  // The notice as `createPartnership` logs it in HQ, stamped with its send's
  // stanza id on the Pi's ack.
  await db.run(
    `INSERT INTO "AdminGroupMessage" (id, "orgId", "waMessageId", "fromMatchTime", text, "askRef", "waStanzaId", "createdAt")
     VALUES ('e2e-hqpair-log', $1, 'mt:pairing:e2e', true, $2, $3, $4, now() - interval '2 minutes')`,
    [ORG_ID, NOTICE, `pairing:${PAIR}:${ORG_ID}`, STANZA],
  );
  engineOn({ yes: { route: "approve" } });
});

test.afterAll(() => {
  clearPipelineStubs();
  clearPairingReplyStub();
  resetDb();
});

test("'2' swipe-replied to the notice declines it", async ({ request, db }) => {
  setPairingReplyStub({ bodies: { "2": "decline" } });
  const out = await say(request, "2", digits(PHONE.admin), { quotedMessageId: STANZA, quotedText: NOTICE, quotedFromMatchTime: true });
  expect(out).toMatchObject({ outcome: "pairing-declined" });
  expect(out.replyText).toMatch(/^Declined\. \*.+\* won't be paired with \*Two FC\*\.$/);
  expect((await row(db))?.status).toBe("ended");
});

test("an unquoted 'yes' as the next message after the notice accepts this club's side", async ({ request, db }) => {
  setPairingReplyStub({ bodies: { yes: "accept" } });
  const out = await say(request, "yes");
  expect(out).toMatchObject({ outcome: "pairing-accepted" });
  expect(out.replyText).toMatch(/^✅ Accepted for \*.+\*\. Waiting for Two FC's owner to accept too\.$/);
  const p = await row(db);
  expect(p?.status).toBe("proposed");
  expect(p?.askerAcceptedAt).not.toBeNull();
});

test("a player of the club replying '1' to it: owners and admins only, nothing changes", async ({ request, db }) => {
  setPairingReplyStub({ bodies: { "1": "accept" } });
  const out = await say(request, "1", digits(PHONE.player), { quotedMessageId: STANZA, quotedText: NOTICE, quotedFromMatchTime: true });
  expect(out.replyText).toBe("Only your club's owners and admins can accept, decline or end a partner club.");
  expect((await row(db))?.askerAcceptedAt).toBeNull();
});
