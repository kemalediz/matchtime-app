/**
 * A partner club's ask reaches the partner's players' group and comes back
 * with its WhatsApp id (cross-club ask, slice S2, 2026-10-16).
 *
 *   - the post is a BotJob of the PARTNER club: the partner's own poll
 *     hands it to the Pi as a group message, and the asking club's poll
 *     does not;
 *   - the ack stamps the post's WhatsApp id on the ask (what a quoted
 *     reply will be matched by, slice S3);
 *   - the sweep in the partner's poll closes it when the place is filled
 *     and posts one line in that group, once.
 */
import { test, expect, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-xpost-sutton";
const PARTNER_GROUP = "120363999000000081@g.us";
const ASK = "e2e-xpost-ask";
const JOB = "e2e-xpost-job";

interface Instruction {
  kind: string;
  key?: string;
  text?: string;
}

async function poll(request: APIRequestContext, groupId: string, caps = "admin-group,quoted-id"): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-mt-pi-caps": caps },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("the post goes out in the partner's group, its id comes back, and a filled place closes it with one line", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","whatsappGroupId","whatsappBotEnabled","createdAt","updatedAt")
     VALUES ($1,'Sutton Posters',$1,$2,'approved',$3,true,now(),now())`,
    [PARTNER, `${PARTNER}-invite`, PARTNER_GROUP],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-xpost-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ORG_ID, PARTNER, U.admin],
  );
  await db.run(`INSERT INTO "BotJob" (id,"orgId",kind,text,"pollOptions","createdAt") VALUES ($1,$2,'group','⚽ *E2E Test FC* need 1 player',ARRAY[]::text[],now())`, [JOB, PARTNER]);
  const match = await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.upcoming]);
  await db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postJobId","postBy","closesAt","createdAt","updatedAt")
     VALUES ($1,'e2e-xpost-pair',$2,$3,$4,1,'posted','button',now(),$5,$6,$7,now(),now())`,
    [ASK, ORG_ID, PARTNER, MATCH.upcoming, JOB, new Date(match!.date.getTime() - 4 * 3600_000), match!.date],
  );

  // The asking club's poll does not carry the partner's post.
  const own = await poll(request, E2E.GROUP_ID);
  expect(own.some((i) => i.key === `botjob-${JOB}`)).toBe(false);

  // Review M3: a Pi that does not forward quoted ids is never handed it.
  const older = await poll(request, PARTNER_GROUP, "admin-group");
  expect(older.some((i) => i.key === `botjob-${JOB}`)).toBe(false);

  // The partner's poll does, as a group message.
  const theirs = await poll(request, PARTNER_GROUP);
  const post = theirs.find((i) => i.key === `botjob-${JOB}`);
  expect(post?.kind).toBe("group-message");

  // The Pi acknowledges it with the message id.
  const ack = await request.post("/api/whatsapp/ack", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { key: `botjob-${JOB}`, kind: "group-message", waMessageId: "3EB0XPOST01" },
  });
  expect(ack.status()).toBe(200);
  expect((await db.one<{ id: string | null }>(`SELECT "postWaMessageId" AS id FROM "PartnerAsk" WHERE id = $1`, [ASK]))?.id).toBe("3EB0XPOST01");

  // The asking club fills its place itself: the next poll closes the ask
  // and queues one line for the partner's group.
  await db.run(`UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.bench]);
  // The sweep runs first in the poll, so the line goes out in this same poll.
  const lines = await poll(request, PARTNER_GROUP);
  expect((await db.one<{ status: string }>(`SELECT status FROM "PartnerAsk" WHERE id = $1`, [ASK]))?.status).toBe("filled");
  const filled = lines.filter((i) => i.kind === "group-message" && /place is filled/.test(i.text ?? ""));
  expect(filled).toHaveLength(1);
  // A further poll sends nothing more.
  const again = await poll(request, PARTNER_GROUP);
  expect(again.filter((i) => /place is filled/.test(i.text ?? ""))).toHaveLength(0);
});
