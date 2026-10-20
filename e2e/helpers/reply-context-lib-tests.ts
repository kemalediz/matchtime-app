/**
 * The quoted-reply resolver (`src/lib/reply-context.ts`) and the
 * `waStanzaId` backfill, against the REAL embedded Postgres, under tsx
 * (the lib is called with the Prisma 7 generated client, which
 * Playwright's transpiler cannot load). Invoked by
 * e2e/api/reply-context.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * `src/lib/__tests__/reply-context.test.ts` proves the rules on a fake.
 * What only a real database can show:
 *   - the real client satisfies `ReplyContextDb` and its OR query runs;
 *   - a row found by the indexed `waStanzaId`, and a row whose column is
 *     still empty found on its serialised `waMessageId`;
 *   - a BotJob DM's words, a scheduler DM's stored words, and the
 *     recipient check against the real `User.phoneNumber` / `BotJob.phone`;
 *   - the migration's backfill UPDATE agrees with `bareWhatsAppId` row for
 *     row (the statement is read out of the migration file itself).
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeTestDbUrl, E2E_DB_URL, REPO_ROOT } from "./env";
import { MATCH, ORG_ID, PHONE, U } from "./constants";

const MIGRATION = path.join(
  REPO_ROOT,
  "prisma/migrations/20261020120000_sent_notification_reply_context/migration.sql",
);

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { resolveQuotedBotMessage, logDmQuote } = await import("@/lib/reply-context");
  const { bareWhatsAppId } = await import("@/lib/quoted-message");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-rc-";
  const chat = `${PHONE.player.replace(/^\+/, "")}@s.whatsapp.net`;
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3600 * 1000);
  const playerDigits = PHONE.player.replace(/^\+/, "");

  try {
    await db.sentNotification.createMany({
      data: [
        {
          key: `${P}${MATCH.pay}:pay-chase:${U.player}:d1`,
          kind: "dm",
          matchId: MATCH.pay,
          targetUser: U.player,
          waMessageId: `true_${chat}_3EB0RCPAY`,
          waStanzaId: "3EB0RCPAY",
          text: "Hi Pat, you owe £8. Pay here: https://mt.example/p/x",
          createdAt: ago(20),
        },
        {
          // Acked before the column existed, never backfilled.
          key: `${P}${MATCH.rate}:rate-reminder:${U.player}:d1`,
          kind: "dm",
          matchId: MATCH.rate,
          targetUser: U.player,
          waMessageId: `true_${chat}_3EB0RCRATE`,
          createdAt: ago(10),
        },
        {
          key: `botjob-${P}job1`,
          kind: "dm",
          waMessageId: `true_${chat}_3EB0RCJOB`,
          waStanzaId: "3EB0RCJOB",
          createdAt: ago(3),
        },
        {
          // Somebody else's DM: never Pat's quote.
          key: `${P}${MATCH.pay}:pay-chase:${U.rater}:d1`,
          kind: "dm",
          matchId: MATCH.pay,
          targetUser: U.rater,
          waMessageId: `true_447700900004@s.whatsapp.net_3EB0RCRATER`,
          waStanzaId: "3EB0RCRATER",
          text: "Hi Riley",
          createdAt: ago(5),
        },
      ],
    });
    await db.botJob.create({
      data: {
        id: `${P}job1`,
        orgId: ORG_ID,
        kind: "dm",
        phone: playerDigits,
        text: "💷 Pat, the match fee is £8.",
        sentAt: ago(2.9),
      },
    });

    const phones = [playerDigits];
    const q = (id: string | null, fromMatchTime = true) => ({ id, text: "(the Pi's quoted text)", fromMatchTime });

    {
      const got = await resolveQuotedBotMessage(db, { quote: q("3EB0RCPAY"), phones, now });
      assert.equal(got?.key, `${P}${MATCH.pay}:pay-chase:${U.player}:d1`);
      assert.equal(got?.text, "Hi Pat, you owe £8. Pay here: https://mt.example/p/x");
      assert.equal(got?.topic, "paymentCollection");
      assert.equal(got?.matchId, MATCH.pay);
      ok("a scheduler DM, found by the indexed stanza id: stored words, topic, match");
    }
    {
      const got = await resolveQuotedBotMessage(db, { quote: q("3EB0RCRATE"), phones: ["+44 7700 900003"], now });
      assert.equal(got?.key, `${P}${MATCH.rate}:rate-reminder:${U.player}:d1`);
      assert.equal(got?.topic, "playerRating");
      assert.equal(got?.text, "(the Pi's quoted text)", "no stored words: the Pi's text");
      ok("a row with an empty waStanzaId is found on its serialised waMessageId");
    }
    {
      const got = await resolveQuotedBotMessage(db, { quote: q(`true_${chat}_3EB0RCJOB`), phones, now });
      assert.equal(got?.key, `botjob-${P}job1`);
      assert.equal(got?.text, "💷 Pat, the match fee is £8.");
      assert.ok(got?.sentAt instanceof Date);
      ok("a BotJob DM resolves to the job's words (serialised quoted id)");
    }
    {
      const got = await resolveQuotedBotMessage(db, { quote: q("3EB0RCRATER", false), phones, now });
      assert.equal(got, null);
      const quoteOnly = await resolveQuotedBotMessage(db, { quote: q("3EB0RCRATER"), phones, now });
      assert.equal(quoteOnly?.key, null);
      ok("another person's DM is not this person's quote");
    }
    {
      const lines: string[] = [];
      const got = await logDmQuote(db, {
        body: { quotedMessageId: "3EB0RCPAY", quotedText: "Hi Pat", quotedFromMatchTime: true },
        waMessageId: "e2e-w1",
        phones,
        now,
        log: (l) => lines.push(l),
      });
      assert.equal(got?.matchId, MATCH.pay);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /resolved=yes/);
      assert.doesNotMatch(lines[0], /Hi Pat|owe/);
      ok("the route's log line: resolved, no text");
    }

    // ── The migration's backfill, statement for statement ────────────
    {
      const sql = readFileSync(MIGRATION, "utf8");
      const m = /-- BACKFILL:BEGIN[^\n]*\n(?:--[^\n]*\n)*([\s\S]*?)-- BACKFILL:END/.exec(sql);
      assert.ok(m, "the migration marks its backfill statement");
      const backfill = m[1].trim().replace(/;$/, "");

      const forms: Array<[string, string]> = [
        [`${P}bf1`, `true_${chat}_3EB0BF1`],
        [`${P}bf2`, "true_120363000000009200@g.us_3EB0BF2_447700900999@s.whatsapp.net"],
        [`${P}bf3`, "false_120363000000009200@g.us_3EB0BF3_158055467598020@lid"],
        [`${P}bf4`, "3EB0BF4"],
        [`${P}bf5`, " true_x@c.us_3EB0BF5 "],
        [`${P}bf6`, "wamid.HBgM"],
      ];
      await db.sentNotification.createMany({
        data: forms.map(([key, waMessageId]) => ({ key, kind: "dm", waMessageId })),
      });
      await db.$executeRawUnsafe(backfill);
      const rows = await db.sentNotification.findMany({
        where: { key: { in: forms.map(([k]) => k) } },
        select: { key: true, waMessageId: true, waStanzaId: true },
      });
      assert.equal(rows.length, forms.length);
      for (const r of rows) {
        assert.equal(r.waStanzaId, bareWhatsAppId(r.waMessageId), `backfill of ${r.waMessageId}`);
      }
      const legacy = await db.sentNotification.findUnique({
        where: { key: `${P}${MATCH.rate}:rate-reminder:${U.player}:d1` },
        select: { waStanzaId: true },
      });
      assert.equal(legacy?.waStanzaId, "3EB0RCRATE");
      const kept = await db.sentNotification.findUnique({
        where: { key: `${P}${MATCH.pay}:pay-chase:${U.player}:d1` },
        select: { waStanzaId: true },
      });
      assert.equal(kept?.waStanzaId, "3EB0RCPAY", "a filled column is left alone");
      ok(`the migration's backfill agrees with bareWhatsAppId (${forms.length} id forms)`);

      const again = await resolveQuotedBotMessage(db, { quote: q("3EB0RCRATE"), phones, now });
      assert.equal(again?.key, `${P}${MATCH.rate}:rate-reminder:${U.player}:d1`);
      ok("after the backfill the legacy row is found by its stanza id");
    }

    console.log(`OK: ${n} reply-context checks against Postgres`);
  } finally {
    await db.sentNotification.deleteMany({ where: { OR: [{ key: { startsWith: P } }, { key: { startsWith: `botjob-${P}` } }] } });
    await db.botJob.deleteMany({ where: { id: { startsWith: P } } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
