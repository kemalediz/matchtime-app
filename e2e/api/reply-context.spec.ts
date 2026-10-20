/**
 * Quoted-reply context, slices S0 to S2 (2026-10-20): which MatchTime
 * message a player's WhatsApp swipe-reply quotes. S0/S1 only logged it; S2
 * hands it (or MatchTime's recent DMs) to the payment-claim and
 * match-availability classifiers, whose live checks are in e2e/sim/*-live.
 *
 *   - the dispatch claim keeps the words it hands the Pi;
 *   - the ack stamps the bare stanza id beside the serialised id;
 *   - a handler that reads no chat context answers a quoted DM as before;
 *   - the resolver, the chat context and the migration's backfill against real Postgres
 *     (tsx, e2e/helpers/reply-context-lib-tests.ts);
 *   - the migration file itself, run whole on a table without the columns,
 *     then again (idempotent).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { PHONE, londonAt } from "../helpers/constants";
import { E2E, REPO_ROOT } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  resetDb();
});

interface Instruction {
  kind: string;
  key: string;
  targetUser?: string;
  matchId?: string;
  text?: string;
}

async function poll(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

let n = 0;
async function postDm(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { waMessageId: `e2e-rc-dm-${Date.now()}-${++n}`, authorName: null, ...data },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test("a claimed DM keeps its words, and its ack stamps the bare stanza id", async ({ request, db }) => {
  // 18:00-19:00 London is the per-player pay-chase DM window.
  const dm = (await poll(request, londonAt(0, 18, 30))).find((i) => i.kind === "dm" && !!i.text);
  expect(dm, "the fixture world should hand out a DM with words in this window").toBeTruthy();

  const claimed = await db.one<{ text: string | null; wa_stanza_id: string | null }>(
    `SELECT text, "waStanzaId" AS wa_stanza_id FROM "SentNotification" WHERE key = $1`,
    [dm!.key],
  );
  expect(claimed?.text).toBe(dm!.text!.slice(0, 1000));
  expect(claimed?.wa_stanza_id).toBeNull();

  const res = await request.post("/api/whatsapp/ack", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { key: dm!.key, kind: dm!.kind, waMessageId: "true_447700900003@s.whatsapp.net_3EB0E2ERC1" },
  });
  expect(res.status(), await res.text()).toBe(200);

  const acked = await db.one<{ wa_message_id: string; wa_stanza_id: string; text: string | null }>(
    `SELECT "waMessageId" AS wa_message_id, "waStanzaId" AS wa_stanza_id, text FROM "SentNotification" WHERE key = $1`,
    [dm!.key],
  );
  expect(acked?.wa_message_id).toBe("true_447700900003@s.whatsapp.net_3EB0E2ERC1");
  expect(acked?.wa_stanza_id).toBe("3EB0E2ERC1");
  expect(acked?.text, "the ack leaves the claim's words alone").toBe(claimed?.text);
});

test("a handler that reads no chat context answers a quoted DM exactly as one without", async ({ request }) => {
  const quote = { quotedMessageId: "3EB0NOPE", quotedText: "Rate your teammates", quotedFromMatchTime: true };
  const plain = await postDm(request, { phone: PHONE.opt, body: "stop messaging me about ratings please" });
  const quoted = await postDm(request, { phone: PHONE.opt, body: "stop messaging me about ratings please", ...quote });
  expect(plain).toMatchObject({ handled: "dm-subscription", cmd: "opt-out-ratings" });
  expect(quoted).toEqual(plain);

  const strangerPlain = await postDm(request, { phone: "+447700900999", body: "hello" });
  const strangerQuoted = await postDm(request, { phone: "+447700900999", body: "hello", ...quote });
  expect(strangerQuoted).toEqual(strangerPlain);
});

test("the resolver and the backfill against real Postgres (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/reply-context-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`reply-context lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});

test("the migration applies whole to a table without the columns, fills the ids, and runs again harmlessly", async ({ db }) => {
  const sql = readFileSync(
    path.join(REPO_ROOT, "prisma/migrations/20261020120000_sent_notification_reply_context/migration.sql"),
    "utf8",
  );
  // The table as production has it before S0.
  await db.run(`DROP INDEX IF EXISTS "SentNotification_waStanzaId_idx"`);
  await db.run(`ALTER TABLE "SentNotification" DROP COLUMN IF EXISTS "waStanzaId", DROP COLUMN IF EXISTS "text"`);
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "createdAt")
     VALUES ('e2e-rc-mig-1', 'e2e-rc-mig-1', 'dm', 'true_447700900003@s.whatsapp.net_3EB0MIG1', now()),
            ('e2e-rc-mig-2', 'e2e-rc-mig-2', 'dm', NULL, now())`,
  );

  await db.run(sql);
  await db.run(sql);

  const cols = await db.all<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'SentNotification' AND column_name IN ('waStanzaId', 'text') ORDER BY column_name`,
  );
  expect(cols).toEqual([
    { column_name: "text", data_type: "text", is_nullable: "YES" },
    { column_name: "waStanzaId", data_type: "text", is_nullable: "YES" },
  ]);
  const idx = await db.all(`SELECT 1 FROM pg_indexes WHERE tablename = 'SentNotification' AND indexname = 'SentNotification_waStanzaId_idx'`);
  expect(idx).toHaveLength(1);
  const rows = await db.all<{ id: string; wa_stanza_id: string | null }>(
    `SELECT id, "waStanzaId" AS wa_stanza_id FROM "SentNotification" WHERE id LIKE 'e2e-rc-mig-%' ORDER BY id`,
  );
  expect(rows).toEqual([
    { id: "e2e-rc-mig-1", wa_stanza_id: "3EB0MIG1" },
    { id: "e2e-rc-mig-2", wa_stanza_id: null },
  ]);
  await db.run(`DELETE FROM "SentNotification" WHERE id LIKE 'e2e-rc-mig-%'`);
});
