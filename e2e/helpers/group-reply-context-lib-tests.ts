/**
 * The GROUP quoted-reply resolver (`loadGroupReplyContexts`, slice S4,
 * 2026-10-20) against the REAL embedded Postgres, under tsx (the Prisma 7
 * generated client cannot load under Playwright's transpiler). Invoked by
 * e2e/api/group-reply-context.spec.ts; exits non-zero on any failure.
 *
 * `src/lib/__tests__/reply-context-group.test.ts` proves the rules on a
 * fake. What only a real database shows: the real client satisfies
 * `GroupReplyContextDb` and every query runs (the stanza OR, the
 * `contains` reads on `AnalyzedMessage` and `AdminGroupMessage`, the
 * match's activity and club), and that another club's rows never answer.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { MATCH, ORG_ID, PHONE, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  const { loadGroupReplyContexts, renderGroupReplyContext, contextMatchLabel } = await import("@/lib/reply-context");
  const { rosterNameByPhone } = await import("@/lib/roster-name-by-phone");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };
  const P = "e2e-grc-";
  const GROUP = "120363000000009300@g.us";
  const now = new Date();
  const ago = (m: number) => new Date(now.getTime() - m * 60 * 1000);
  const OTHER_ORG = `${P}other-org`;

  try {
    await db.organisation.create({ data: { id: OTHER_ORG, name: "Other club", slug: `${P}other` } }).catch(() => {});
    await db.sentNotification.createMany({
      data: [
        // A scheduler squad post on this club's upcoming match.
        { key: `${P}${MATCH.upcoming}:evening-update:d1`, kind: "group-message", matchId: MATCH.upcoming, waMessageId: `true_${GROUP}_3EB0GSQUAD`, waStanzaId: "3EB0GSQUAD", text: "Squad: 12/14", createdAt: ago(60) },
        // A group BotJob of this club, and one of another club.
        { key: `botjob-${P}job1`, kind: "group-message", waMessageId: `true_${GROUP}_3EB0GJOB`, waStanzaId: "3EB0GJOB", createdAt: ago(30) },
        { key: `botjob-${P}job2`, kind: "group-message", waMessageId: `true_x@g.us_3EB0GJOB2`, waStanzaId: "3EB0GJOB2", createdAt: ago(30) },
        // Acked before the stanza column existed.
        { key: `${P}${MATCH.upcoming}:announce-match:d1`, kind: "group-message", matchId: MATCH.upcoming, waMessageId: `true_${GROUP}_3EB0GLEGACY`, createdAt: ago(90) },
      ],
    });
    await db.botJob.createMany({
      data: [
        { id: `${P}job1`, orgId: ORG_ID, kind: "group", text: "Pay links are live", sentAt: ago(30) },
        { id: `${P}job2`, orgId: OTHER_ORG, kind: "group", text: "theirs", sentAt: ago(30) },
      ],
    });
    await db.analyzedMessage.create({
      data: {
        waMessageId: `false_${GROUP}_3EB0GALI_447700900003@s.whatsapp.net`,
        orgId: ORG_ID,
        groupId: GROUP,
        authorUserId: U.player,
        authorName: "pat 🔥",
        body: "I'm out tonight lads",
        handledBy: "router-gate",
        createdAt: ago(10),
      },
    });
    await db.adminGroupMessage.create({
      data: { orgId: ORG_ID, waMessageId: `false_hq@g.us_3EB0GHQ_447700900001@s.whatsapp.net`, senderUserId: U.admin, text: "Bilal is out", createdAt: ago(5) },
    });

    const up = await db.match.findUnique({ where: { id: MATCH.upcoming }, select: { date: true, activity: { select: { name: true } } } });
    assert.ok(up);
    const pat = await db.user.findUnique({ where: { id: U.player }, select: { name: true } });
    const alex = await db.user.findUnique({ where: { id: U.admin }, select: { name: true } });

    const out = await loadGroupReplyContexts(db, {
      orgId: ORG_ID,
      channel: "group",
      now,
      batch: [],
      authorByPhone: (p) => rosterNameByPhone(ORG_ID, p),
      messages: [
        { id: "squad", quote: { id: "3EB0GSQUAD", text: "Squad", fromMatchTime: true } },
        { id: "job", quote: { id: "3EB0GJOB", text: "Pay", fromMatchTime: true } },
        { id: "theirs", quote: { id: "3EB0GJOB2", text: "pi words", fromMatchTime: true } },
        { id: "legacy", quote: { id: "3EB0GLEGACY", text: "pi", fromMatchTime: true } },
        { id: "pat", quote: { id: "3EB0GALI", text: "I'm out", fromMatchTime: false } },
        { id: "byphone", quote: { id: null, text: "in", fromMatchTime: false, authorName: "x", authorPhone: PHONE.player.replace(/^\+/, "") } },
      ],
    });
    assert.deepEqual(out.get("squad"), {
      author: null,
      at: ago(60),
      text: "Squad: 12/14",
      topic: "attendance",
      matchId: MATCH.upcoming,
      match: contextMatchLabel(up.activity.name, up.date),
    });
    ok("MatchTime's scheduler post by its stanza id, with its words, topic and match");
    assert.equal(out.get("job")?.text, "Pay links are live");
    assert.equal(out.get("theirs")?.text, "pi words");
    assert.equal(out.get("theirs")?.at, null);
    ok("this club's group BotJob by id; another club's never");
    assert.equal(out.get("legacy")?.topic, "attendance");
    ok("a row with no stanza column, on its serialised id");
    assert.deepEqual(out.get("pat")?.author, { name: pat?.name ?? null });
    assert.equal(out.get("pat")?.text, "I'm out tonight lads");
    ok("a member's analysed message, with their roster name");
    assert.deepEqual(out.get("byphone")?.author, { name: pat?.name ?? null });
    ok("the Pi's phone, read-only, finds the roster name");
    assert.match(renderGroupReplyContext({ now, quoted: out.get("pat")! }), new RegExp(`THEY ARE REPLYING TO ${pat?.name}'s message of `));

    const other = await loadGroupReplyContexts(db, {
      orgId: OTHER_ORG,
      channel: "group",
      now,
      batch: [],
      messages: [{ id: "pat", quote: { id: "3EB0GALI", text: "I'm out", fromMatchTime: false } }, { id: "squad", quote: { id: "3EB0GSQUAD", text: "pi", fromMatchTime: true } }],
    });
    assert.equal(other.get("pat")?.text, "I'm out");
    assert.equal(other.get("pat")?.at, null);
    assert.equal(other.get("squad")?.matchId, null);
    ok("another club never reads this club's messages or posts");

    const hq = await loadGroupReplyContexts(db, {
      orgId: ORG_ID,
      channel: "hq",
      now,
      batch: [],
      messages: [{ id: "h", quote: { id: "3EB0GHQ", text: null, fromMatchTime: false } }],
    });
    assert.deepEqual(hq.get("h")?.author, { name: alex?.name ?? null });
    assert.equal(hq.get("h")?.text, "Bilal is out");
    ok("HQ: another organiser's message from the HQ log");

    console.log(`OK: ${n} group reply-context checks against Postgres`);
  } finally {
    await db.sentNotification.deleteMany({ where: { OR: [{ key: { startsWith: P } }, { key: { startsWith: `botjob-${P}` } }] } });
    await db.botJob.deleteMany({ where: { id: { startsWith: P } } });
    await db.analyzedMessage.deleteMany({ where: { waMessageId: { contains: "3EB0GALI" } } });
    await db.adminGroupMessage.deleteMany({ where: { waMessageId: { contains: "3EB0GHQ" } } });
    await db.organisation.deleteMany({ where: { id: OTHER_ORG } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
