/**
 * Conversational replies before bulk sends (FNF, 2026-10-16), END TO END.
 *
 * The real night: the fee release queued 16 pay-link DMs at 22:39; at
 * 22:46 Akram DMed "I've transferred already" and his reply and the
 * collector's notice waited ~10 minutes behind the pay links, because the
 * Pi sends the FIRST DM in the due-posts list once a minute.
 *
 * Here: 16 pay-link BotJobs are queued, then a player DMs "Paid" through
 * the real dm-reply route (the model stubbed, `paid-claim-dm.spec.ts`'s
 * seam). The reply and the collector notice are written with priority 1.
 * Then due-posts is read with the flag OFF (the env default in the suite)
 * and ON (the MT_TEST_MODE header seam, src/lib/dm-reply-priority.ts).
 *
 * The pure order rules are in src/lib/__tests__/dm-reply-priority*.test.ts,
 * the Pi's order and pacing in whatsapp-bot/src/scheduler.dm-order.test.ts.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { setPaymentClaimStub, clearPaymentClaimStub } from "../helpers/stub";
import { DM_REPLY_PRIORITY_TEST_HEADER } from "@/lib/dm-reply-priority";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key: string;
  phone?: string;
  text?: string;
}

const bare = (p: string) => p.replace(/^\+/, "");
const PAY_PHONES = Array.from({ length: 16 }, (_, i) => `4477009991${String(i).padStart(2, "0")}`);

async function duePosts(
  request: APIRequestContext,
  opts: { flag?: "1" | "0"; claim?: boolean } = {},
): Promise<Instruction[]> {
  const headers: Record<string, string> = { "x-api-key": E2E.WHATSAPP_API_KEY };
  if (!opts.claim) headers["x-no-claim"] = "1";
  if (opts.flag) headers[DM_REPLY_PRIORITY_TEST_HEADER] = opts.flag;
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-prio-${Date.now()}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The fee release: 16 pay links, queued seven minutes ago, oldest first.
 *  "createdAt" is a timestamp WITHOUT time zone holding UTC (Prisma writes
 *  it from JS), so the SQL side says UTC explicitly: a bare now() would be
 *  the session's local time, an hour ahead in BST. */
async function queuePayLinks(db: TestDb): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < PAY_PHONES.length; i++) {
    const id = `e2e-prio-pay-${String(i).padStart(2, "0")}`;
    await db.run(
      `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt")
       VALUES ($1, $2, 'dm', $3, $4, (now() AT TIME ZONE 'UTC') - interval '7 minutes' + ($5 || ' milliseconds')::interval)`,
      [id, ORG_ID, PAY_PHONES[i], `Pay link ${i}`, String(i)],
    );
    ids.push(`botjob-${id}`);
  }
  return ids;
}

const dms = (list: Instruction[]) => list.filter((i) => i.kind === "dm");

test.beforeAll(() => resetDb());
test.afterAll(() => clearPaymentClaimStub());

let payKeys: string[] = [];
let replyKey = "";
let noticeKey = "";

test("a 'Paid' after a fee release: the reply and the collector notice are marked, the pay links are not", async ({
  request,
  db,
}) => {
  payKeys = await queuePayLinks(db);
  setPaymentClaimStub({ bodies: { "I've transferred already": "paid" } });
  const json = await postDm(request, PHONE.player, "I've transferred already");
  expect(json.handled).toBe("paid-claim");

  const rows = await db.all<{ id: string; phone: string; priority: number; text: string }>(
    `SELECT id, phone, priority, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND "sentAt" IS NULL ORDER BY "createdAt" ASC`,
    [ORG_ID],
  );
  const reply = rows.find((r) => r.phone === bare(PHONE.player) && r.text.startsWith("Thanks Pat"));
  const notice = rows.find((r) => r.phone === bare(PHONE.collector) && r.text.includes("paid you directly"));
  expect(reply?.priority).toBe(1);
  expect(notice?.priority).toBe(1);
  for (const r of rows.filter((r) => r.id.startsWith("e2e-prio-pay-"))) expect(r.priority).toBe(0);
  replyKey = `botjob-${reply!.id}`;
  noticeKey = `botjob-${notice!.id}`;
});

test("flag OFF: today's order, the reply waits behind all 16 pay links; the header '0' changes nothing", async ({
  request,
}) => {
  const plain = dms(await duePosts(request));
  const off = dms(await duePosts(request, { flag: "0" }));
  expect(off.map((i) => i.key)).toEqual(plain.map((i) => i.key));

  const keys = plain.map((i) => i.key);
  const lastPay = Math.max(...payKeys.map((k) => keys.indexOf(k)));
  expect(payKeys.every((k) => keys.includes(k))).toBe(true);
  expect(keys.indexOf(replyKey)).toBeGreaterThan(lastPay);
  expect(keys.indexOf(noticeKey)).toBeGreaterThan(lastPay);
});

test("flag ON: the reply and the collector notice go before every pay link; nothing added or dropped", async ({
  request,
}) => {
  const off = await duePosts(request, { flag: "0" });
  const on = await duePosts(request, { flag: "1" });

  // The same instructions, only the DMs reordered among themselves.
  expect([...on.map((i) => i.key)].sort()).toEqual([...off.map((i) => i.key)].sort());
  expect(on.map((i) => i.kind)).toEqual(off.map((i) => i.kind));
  const onNonDm = on.filter((i) => i.kind !== "dm").map((i) => i.key);
  const offNonDm = off.filter((i) => i.kind !== "dm").map((i) => i.key);
  expect(onNonDm).toEqual(offNonDm);

  const keys = dms(on).map((i) => i.key);
  const firstPay = Math.min(...payKeys.map((k) => keys.indexOf(k)));
  expect(keys.indexOf(replyKey)).toBeLessThan(firstPay);
  expect(keys.indexOf(noticeKey)).toBeLessThan(firstPay);
  // The pay links keep their own order.
  expect(keys.filter((k) => payKeys.includes(k))).toEqual(payKeys);

  // Per recipient: every DM to the player or the collector keeps its
  // relative order from the flag-off list.
  for (const phone of [bare(PHONE.player), bare(PHONE.collector)]) {
    const offOrder = dms(off).filter((i) => i.phone === phone).map((i) => i.key);
    const onOrder = dms(on).filter((i) => i.phone === phone).map((i) => i.key);
    expect(onOrder).toEqual(offOrder);
  }
});

test("flag ON, claimed poll (what the Pi gets): the first DM it is handed is a reply, not a pay link", async ({
  request,
}) => {
  const claimed = dms(await duePosts(request, { flag: "1", claim: true }));
  expect(claimed.length).toBeGreaterThan(0);
  expect(payKeys).not.toContain(claimed[0].key);
  const firstPay = Math.min(...payKeys.map((k) => claimed.map((i) => i.key).indexOf(k)));
  expect(claimed.findIndex((i) => i.key === replyKey)).toBeLessThan(firstPay);
});
