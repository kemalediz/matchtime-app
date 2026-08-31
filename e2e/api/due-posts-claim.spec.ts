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
 *
 * Also covers the 2026-08-31 outbound guards: the repetition guard (the
 * same group text, again, too soon) and the fact that DMs are gated by
 * neither. The pure decision logic is unit-tested in
 * src/lib/__tests__/dispatch-claim.test.ts; what these prove is the wiring
 * — that the hash ledger is really written to SentNotification, really
 * read back on the next poll, and really only suppresses group posts.
 */
import { test, expect, resetDb } from "../fixtures";
import { hashOutboundText, OUTBOUND_TEXT_LOG_KIND } from "@/lib/dispatch-claim";
import { ORG_ID, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  targetUser?: string;
  matchId?: string;
  text?: string;
}

async function poll(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    { headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() } },
  );
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

/** Poll WITHOUT claiming (MT_TEST_MODE preview) — used to learn what a
 *  cycle would send before we set the guard up against it. */
async function preview(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    {
      headers: {
        "x-api-key": E2E.WHATSAPP_API_KEY,
        "x-test-now": now.toISOString(),
        "x-no-claim": "1",
      },
    },
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

// ── Outbound guards (2026-08-31) ─────────────────────────────────────

/** 17:00-18:00 London is the evening-update window — the one reliable
 *  group post in the fixture world (bot-scheduler.ts:844). */
const EVENING = () => londonAt(0, 17, 30);
/** 18:00-19:00 London is the per-player pay-chase DM window. */
const DM_WINDOW = () => londonAt(0, 18, 30);

/** The evening update specifically — the cycle also emits a one-off
 *  bot-intro group post, which is a different message. */
const isEveningUpdate = (i: Instruction) =>
  i.kind === "group-message" && !!i.key?.includes("evening-update") && !!i.text;

test("a dispatched group post writes its text hash to the outbound-text-log ledger", async ({
  request,
  db,
}) => {
  const post = (await poll(request, EVENING())).find((i) => isEveningUpdate(i));
  expect(post, "fixture world should produce an evening-update group post").toBeTruthy();

  const ledger = await db.all<{ key: string; kind: string }>(
    `SELECT key, kind FROM "SentNotification" WHERE kind = $1`,
    [OUTBOUND_TEXT_LOG_KIND],
  );
  expect(ledger.length).toBeGreaterThan(0);
  const expectedKey = `txtlog:${ORG_ID}:${hashOutboundText(post!.text!)}:${post!.key}`;
  expect(ledger.map((r) => r.key)).toContain(expectedKey);
});

test("the repetition guard blocks a group post whose text already went out 3 times", async ({
  request,
  db,
}) => {
  // Learn what this cycle WOULD post, without claiming it.
  const planned = (await preview(request, EVENING())).find((i) => isEveningUpdate(i));
  expect(planned).toBeTruthy();

  // Pretend that exact text has already gone out three times, just now.
  // NB: createdAt must sit inside the guard's window as measured from
  // the x-test-now clock, not real wall time.
  const hash = hashOutboundText(planned!.text!);
  for (let i = 0; i < 3; i++) {
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ($1, $2, $3, $4)`,
      [
        `rep-seed-${i}`,
        `txtlog:${ORG_ID}:${hash}:seeded-${i}`,
        OUTBOUND_TEXT_LOG_KIND,
        new Date(EVENING().getTime() - 60_000).toISOString(),
      ],
    );
  }

  const dispatched = await poll(request, EVENING());
  expect(dispatched.map((i) => i.key)).not.toContain(planned!.key);
  // Not claimed either — the key stays free so it can still go out later.
  const claimed = await db.all(`SELECT 1 FROM "SentNotification" WHERE key = $1`, [planned!.key]);
  expect(claimed).toHaveLength(0);
});

test("DMs are dispatched even when their exact text is blocked in the group", async ({
  request,
  db,
}) => {
  const dm = (await preview(request, DM_WINDOW())).find((i) => i.kind === "dm" && i.text);
  expect(dm, "fixture world should produce a pay-chase DM").toBeTruthy();

  const hash = hashOutboundText(dm!.text!);
  for (let i = 0; i < 5; i++) {
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ($1, $2, $3, $4)`,
      [
        `dm-seed-${i}`,
        `txtlog:${ORG_ID}:${hash}:seeded-${i}`,
        OUTBOUND_TEXT_LOG_KIND,
        new Date(DM_WINDOW().getTime() - 60_000).toISOString(),
      ],
    );
  }

  const dispatched = await poll(request, DM_WINDOW());
  expect(dispatched.map((i) => i.key)).toContain(dm!.key);
});
