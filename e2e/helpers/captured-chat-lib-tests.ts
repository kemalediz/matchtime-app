/**
 * src/lib/captured-chat.ts against the REAL embedded Postgres, under tsx
 * (the lib is handed the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/self-join-description.spec.ts
 * via execFile; exits non-zero with a readable message on any failure.
 *
 * The unit test proves the statements' text on a mock. What only a real
 * database can show: they parse and run, a late write lands only on a
 * request that is still linked with MatchTime still in the group, it never
 * replaces what is stored, and a removal racing a late write never leaves
 * anything on the removed request.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-chatlib-";
const CHAT = [{ author: "Ali", authorPhone: null, text: "in for Tuesday", timestamp: "2026-10-12T10:00:00.000Z" }];
const DESC = "Tuesdays 21:00, 6 a side. Sort [number removed]";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { db } = await import("@/lib/db");
  const { clearCapturedChat, clearCapturedChatForClub, fillCapturedChatOnReAdd } = await import("@/lib/captured-chat");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };
  const NOW = new Date();

  await db.user.create({ data: { id: `${P}u`, name: "Cleo Chat", email: `${P}u@e2e-test.invalid`, onboarded: true } });
  await db.organisation.create({ data: { id: `${P}org`, name: "Chat lib", slug: `${P}org`, inviteCode: `${P}invite` } });
  let seq = 0;
  async function request(over: { status?: string; botRemovedAt?: Date | null } = {}) {
    const id = `${P}cc-${++seq}`;
    await db.clubConnect.create({
      data: {
        id,
        orgId: `${P}org`,
        userId: `${P}u`,
        phone: "447700900940",
        code: "7CH2",
        status: over.status ?? "group_linked",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        groupId: `${id}@g.us`,
        linkedAt: NOW,
        botRemovedAt: over.botRemovedAt ?? null,
      },
      select: { id: true },
    });
    return id;
  }
  const stored = (id: string) =>
    db.clubConnect.findUnique({ where: { id }, select: { capturedHistory: true, capturedDescription: true, botRemovedAt: true } });

  try {
    // 1. A request still linked, nothing stored: both are stored.
    const live = await request();
    assert.deepEqual(await fillCapturedChatOnReAdd(db, live, { history: CHAT, description: DESC }), { history: 1, description: 1 });
    assert.deepEqual(await stored(live), { capturedHistory: CHAT, capturedDescription: DESC, botRemovedAt: null });
    ok("a re-add fills in the chat and the description of a request that is still linked");

    // 2. It never replaces what is stored.
    assert.deepEqual(await fillCapturedChatOnReAdd(db, live, { history: [{ author: "B", text: "other" }], description: "other" }), {
      history: 0,
      description: 0,
    });
    assert.deepEqual(await stored(live), { capturedHistory: CHAT, capturedDescription: DESC, botRemovedAt: null });
    ok("a second re-add replaces neither");

    // 3. Each fills on its own.
    const half = await request();
    assert.deepEqual(await fillCapturedChatOnReAdd(db, half, { history: [], description: DESC }), { history: 0, description: 1 });
    assert.deepEqual(await fillCapturedChatOnReAdd(db, half, { history: CHAT, description: "later" }), { history: 1, description: 0 });
    assert.deepEqual(await stored(half), { capturedHistory: CHAT, capturedDescription: DESC, botRemovedAt: null });
    ok("the description and the chat are each filled only where it is missing");

    // 4. MatchTime was removed since the request was read: nothing is written.
    const removed = await request({ botRemovedAt: NOW });
    assert.deepEqual(await fillCapturedChatOnReAdd(db, removed, { history: CHAT, description: DESC }), { history: 0, description: 0 });
    assert.deepEqual(await stored(removed), { capturedHistory: null, capturedDescription: null, botRemovedAt: NOW });
    ok("a request MatchTime was removed from is never written");

    // 5. The club was decided since (rejected or approved: the request is closed).
    const closed = await request({ status: "closed" });
    assert.deepEqual(await fillCapturedChatOnReAdd(db, closed, { history: CHAT, description: DESC }), { history: 0, description: 0 });
    assert.deepEqual(await stored(closed), { capturedHistory: null, capturedDescription: null, botRemovedAt: null });
    ok("a closed request is never written");

    // 6. A removal and a late write at the same moment, forty times: whichever
    //    order the database takes them in, nothing is left on a removed request.
    for (let round = 0; round < 40; round++) {
      const id = await request();
      const remove = db.$transaction(async (tx) => {
        await tx.clubConnect.updateMany({ where: { id, botRemovedAt: null }, data: { botRemovedAt: NOW } });
        await clearCapturedChat(tx, id);
      });
      const fill = fillCapturedChatOnReAdd(db, id, { history: CHAT, description: DESC });
      await Promise.all(round % 2 === 0 ? [remove, fill] : [fill, remove]);
      assert.deepEqual(await stored(id), { capturedHistory: null, capturedDescription: null, botRemovedAt: NOW }, `round ${round}`);
    }
    ok("a removal racing a late write never leaves chat or a description behind (40 rounds)");

    // 7. Every request of a club, both columns.
    const a = await request();
    const b = await request({ status: "closed" });
    await fillCapturedChatOnReAdd(db, a, { history: CHAT, description: DESC });
    await db.$executeRaw`UPDATE "ClubConnect" SET "capturedDescription" = ${DESC} WHERE "id" = ${b}`;
    const cleared = await db.$transaction((tx) => clearCapturedChatForClub(tx, `${P}org`));
    assert.ok(cleared >= 2);
    for (const id of [live, half, a, b]) {
      const row = await stored(id);
      assert.equal(row?.capturedHistory, null);
      assert.equal(row?.capturedDescription, null);
    }
    ok("clearing a club's captured chat clears the description on every one of its requests");

    console.log(`OK: ${n} captured-chat checks against Postgres`);
  } finally {
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
