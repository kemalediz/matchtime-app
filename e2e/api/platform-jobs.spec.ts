/**
 * SELF-JOIN SLICE 3: the platform channel, against a real Postgres and the
 * real routes. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 3.3, 7 and 12.
 *
 *   - GET /api/whatsapp/platform-jobs claims and hands over due jobs; a
 *     second poll gets nothing for a job the first one holds.
 *   - POST records the outcome honestly: sent, failed (never sent), release.
 *   - The BRIDGE: a due-posts poll WITHOUT `x-mt-platform-jobs: 1` (a Pi
 *     built before slice 3) carries platform DMs as `platform-<id>`, acked
 *     through /ack; a poll WITH the header carries none.
 *   - Leaving an approved club's group is refused at dispatch.
 *
 * Deterministic: no model is involved in anything here.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

let n = 0;
async function queueDm(purpose = "otp", phone = "447700900951"): Promise<string> {
  const id = `e2e-pj-${Date.now()}-${++n}`;
  await testDb().run(
    `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, status, "createdAt", "updatedAt")
     VALUES ($1, 'dm', $2, $3, $4, 'queued', now(), now())`,
    [id, phone, `Your verification code: *12345${n}*`, purpose],
  );
  return id;
}

async function statusOf(id: string) {
  return testDb().one<{ status: string; sentAt: Date | null; failedAt: Date | null; failReason: string | null; waMessageId: string | null }>(
    `SELECT status, "sentAt", "failedAt", "failReason", "waMessageId" FROM "PlatformJob" WHERE id = $1`,
    [id],
  );
}

async function pollPlatform(request: APIRequestContext) {
  const res = await request.get("/api/whatsapp/platform-jobs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).jobs ?? []) as Array<{ id: string; kind: string; phone?: string; text?: string; groupId?: string }>;
}

async function report(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/platform-jobs", { headers: HEADERS, data: body });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function duePosts(request: APIRequestContext, extra: Record<string, string> = {}) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...HEADERS, ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Array<{ kind: string; key: string; phone?: string; text?: string }>;
}

test.beforeAll(() => {
  resetDb();
});

test.afterEach(async () => {
  // Nothing queued here may leak into another spec's due-posts.
  await testDb().run(`DELETE FROM "PlatformJob"`);
});

test("refuses without the API key", async ({ request }) => {
  expect((await request.get("/api/whatsapp/platform-jobs")).status()).toBe(401);
  expect((await request.post("/api/whatsapp/platform-jobs", { data: { id: "x", outcome: "sent" } })).status()).toBe(401);
});

test("a job is handed out once: claimed on the first poll, absent from the second", async ({ request }) => {
  const id = await queueDm();
  const first = await pollPlatform(request);
  expect(first).toEqual([expect.objectContaining({ id, kind: "dm", phone: "447700900951" })]);
  expect((await statusOf(id))?.status).toBe("claimed");
  expect(await pollPlatform(request)).toEqual([]);
});

test("sent is recorded with the message id", async ({ request }) => {
  const id = await queueDm();
  await pollPlatform(request);
  expect(await report(request, { id, outcome: "sent", waMessageId: "wa-e2e-1" })).toEqual({ ok: true, updated: true });
  const row = await statusOf(id);
  expect(row?.status).toBe("sent");
  expect(row?.sentAt).not.toBeNull();
  expect(row?.waMessageId).toBe("wa-e2e-1");
  // A replayed report changes nothing.
  expect(await report(request, { id, outcome: "failed", error: "late" })).toEqual({ ok: true, updated: false });
  expect((await statusOf(id))?.status).toBe("sent");
});

test("a failed send is recorded as failed with its reason, never as sent, and is not re-emitted", async ({ request }) => {
  const id = await queueDm();
  await pollPlatform(request);
  await report(request, { id, outcome: "failed", error: "not on WhatsApp" });
  const row = await statusOf(id);
  expect(row?.status).toBe("failed");
  expect(row?.sentAt).toBeNull();
  expect(row?.failedAt).not.toBeNull();
  expect(row?.failReason).toBe("not on WhatsApp");
  expect(await pollPlatform(request)).toEqual([]);
});

test("a released DM comes back on the next poll", async ({ request }) => {
  const id = await queueDm();
  await pollPlatform(request);
  await report(request, { id, outcome: "release" });
  expect((await statusOf(id))?.status).toBe("queued");
  expect((await pollPlatform(request)).map((j) => j.id)).toEqual([id]);
});

test("leaving an approved club's group is refused at dispatch", async ({ request }) => {
  const id = `e2e-pj-leave-${Date.now()}`;
  await testDb().run(
    `INSERT INTO "PlatformJob" (id, kind, "groupId", purpose, status, "createdAt", "updatedAt")
     VALUES ($1, 'leave-group', $2, 'leave-group', 'queued', now(), now())`,
    [id, E2E.GROUP_ID],
  );
  expect(await pollPlatform(request)).toEqual([]);
  const row = await statusOf(id);
  expect(row?.status).toBe("failed");
  expect(row?.failReason).toMatch(/approved club/i);
});

test.describe("the due-posts bridge for a Pi built before slice 3", () => {
  test("a poll without the header carries the platform DM first, keyed platform-<id>", async ({ request }) => {
    const id = await queueDm();
    const instructions = await duePosts(request);
    expect(instructions[0]).toEqual({
      kind: "dm",
      key: `platform-${id}`,
      phone: "447700900951",
      text: expect.stringContaining("verification code"),
    });
    expect((await statusOf(id))?.status).toBe("claimed");
  });

  test("its ack with a message id marks the job sent, and writes no SentNotification", async ({ request }) => {
    const id = await queueDm();
    await duePosts(request);
    const res = await request.post("/api/whatsapp/ack", {
      headers: HEADERS,
      data: { key: `platform-${id}`, kind: "dm", waMessageId: "wa-legacy-1" },
    });
    expect(res.status()).toBe(200);
    expect((await statusOf(id))?.status).toBe("sent");
    expect(await testDb().count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`platform-${id}`])).toBe(0);
  });

  test("its ack WITHOUT a message id is unconfirmed, not sent", async ({ request }) => {
    const id = await queueDm();
    await duePosts(request);
    await request.post("/api/whatsapp/ack", { headers: HEADERS, data: { key: `platform-${id}`, kind: "dm" } });
    const row = await statusOf(id);
    expect(row?.status).toBe("unconfirmed");
    expect(row?.sentAt).toBeNull();
  });

  test("its release puts the job back in the queue", async ({ request }) => {
    const id = await queueDm();
    await duePosts(request);
    await request.post("/api/whatsapp/ack", { headers: HEADERS, data: { key: `platform-${id}`, release: true } });
    expect((await statusOf(id))?.status).toBe("queued");
  });

  test("a poll WITH the header carries none (that Pi polls /platform-jobs itself)", async ({ request }) => {
    const id = await queueDm();
    const instructions = await duePosts(request, { "x-mt-platform-jobs": "1" });
    expect(instructions.filter((i) => i.key?.startsWith("platform-"))).toEqual([]);
    expect((await statusOf(id))?.status).toBe("queued");
  });

  test("the seeded club is untouched by the bridge when nothing is queued", async ({ request }) => {
    const withHeader = await duePosts(request, { "x-mt-platform-jobs": "1", "x-no-claim": "1" });
    const without = await duePosts(request, { "x-no-claim": "1" });
    expect(without).toEqual(withHeader);
    expect(await testDb().count(`SELECT COUNT(*) FROM "Organisation" WHERE id = $1`, [ORG_ID])).toBe(1);
  });
});
