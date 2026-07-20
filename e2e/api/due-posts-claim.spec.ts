/**
 * /api/whatsapp/due-posts — claim-on-dispatch.
 *
 * Regression cover for the 2026-07-19 incident: a WhatsApp group received
 * 30+ copies of one roster message because several bot processes on the
 * Pi each received the same due instruction before any of them ACKed it.
 *
 * The endpoint now CLAIMS each instruction (creates its SentNotification
 * row, arbitrated by the @unique constraint on `key`) at the moment it
 * hands it out, so a second poller gets nothing.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  targetUser?: string;
  matchId?: string;
}

async function poll(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    { headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() } },
  );
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

async function ack(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post("/api/whatsapp/ack", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: body,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test.beforeEach(async () => {
  resetDb();
});

test("an instruction is claimed on dispatch — the SECOND poller gets nothing", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 8, 30); // morning-after rate-DM window

  const first = await poll(request, now);
  expect(first.length).toBeGreaterThan(0);
  const keys = first.map((i) => i.key);

  // The dedupe rows exist ALREADY, before any ACK — that is the fix.
  const rows = await db.all<{ key: string; wa_message_id: string | null }>(
    `SELECT key, "waMessageId" as wa_message_id FROM "SentNotification" WHERE key = ANY($1)`,
    [keys],
  );
  expect(rows.length).toBe(keys.length);
  expect(rows.every((r) => r.wa_message_id === null)).toBe(true);

  // A second poller in the very same window — the duplicate-process case —
  // is handed none of them.
  const second = await poll(request, now);
  const overlap = second.map((i) => i.key).filter((k) => keys.includes(k));
  expect(overlap).toEqual([]);
});

test("ACK is an idempotent update: stamps waMessageId, never duplicates the row", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 8, 30);
  const [instr] = await poll(request, now);
  expect(instr?.key).toBeTruthy();

  await ack(request, {
    key: instr.key,
    kind: instr.kind,
    matchId: instr.matchId,
    targetUser: instr.targetUser,
    waMessageId: "wamid.TEST1",
  });
  // Replayed ACK (bot retry) must be harmless.
  await ack(request, {
    key: instr.key,
    kind: instr.kind,
    waMessageId: "wamid.TEST1",
  });

  const rows = await db.all<{ wa_message_id: string | null }>(
    `SELECT "waMessageId" as wa_message_id FROM "SentNotification" WHERE key = $1`,
    [instr.key],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].wa_message_id).toBe("wamid.TEST1");
});

test("ACK side effects survive: a botjob is closed out on ack", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, text, "createdAt")
     VALUES ($1, $2, 'group', $3, now())`,
    ["e2e-botjob-claim-1", ORG_ID, "claim test job"],
  );

  const now = londonAt(0, 8, 30);
  const instrs = await poll(request, now);
  const job = instrs.find((i) => i.key === "botjob-e2e-botjob-claim-1");
  expect(job, "botjob should be dispatched").toBeTruthy();

  await ack(request, { key: job!.key, kind: job!.kind, waMessageId: "wamid.JOB" });

  const rows = await db.all<{ sent_at: string | null }>(
    `SELECT "sentAt" as sent_at FROM "BotJob" WHERE id = $1`,
    ["e2e-botjob-claim-1"],
  );
  expect(rows[0].sent_at).not.toBeNull();

  // And it is not re-emitted.
  const again = await poll(request, now);
  expect(again.map((i) => i.key)).not.toContain("botjob-e2e-botjob-claim-1");
});

test("a released claim is re-emitted (the DM rate-limiter's hold path)", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 8, 30);
  const first = await poll(request, now);
  const dm = first.find((i) => i.kind === "dm");
  expect(dm, "expected at least one DM in this window").toBeTruthy();

  const res = await ack(request, { key: dm!.key, release: true });
  expect(res.released).toBe(true);

  const rows = await db.all(`SELECT 1 FROM "SentNotification" WHERE key = $1`, [dm!.key]);
  expect(rows).toHaveLength(0);

  const second = await poll(request, now);
  expect(second.map((i) => i.key)).toContain(dm!.key);
});
