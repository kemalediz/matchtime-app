/**
 * A GROUP REPLY THROUGH THE REAL ROUTE, STUBBED MODEL (quoted-reply
 * context, slice S4, review of #341). The router and the extractor are
 * stubbed per body; everything else is real: /api/whatsapp/analyze, the
 * reply-context resolver against Postgres, the owners, /api/whatsapp/ack.
 *
 *   - finding 8: "IN" quoting MatchTime's post about ANOTHER match writes
 *     nothing to this match; quoting this match's post registers;
 *   - finding 3: MatchTime's in-group reply is claimed with its words and
 *     match, handed back with a `replyKey`, and the ack stamps its stanza
 *     id, so a later quote of it resolves;
 *   - finding 1: a quote of a member the route could not resolve never
 *     names them, so "he's out" with that quote writes nobody.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { claim, clearExtractorStub, clearRouterStub, facts } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe.skip : test.describe)("group replies through the route (stubbed model)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  const IN = facts([claim({ subject: "sender", personRef: "", polarity: "in" })]);

  test("IN quoting MatchTime's post about another match is not written to this match; this match's post is", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 14, attendance: [{ key: "owner", status: "CONFIRMED" }] })).attach(request);
    const last = await grp.addMatch({ daysFromNow: -7, status: "COMPLETED" });
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId", "waStanzaId", text, "createdAt")
       VALUES ($1, $2, 'group-message', $3, $4, $5, 'Squad for last week', now() - interval '6 days'),
              ($6, $7, 'group-message', $8, $9, $10, 'Squad for this week', now() - interval '1 hour')`,
      [
        `sn-${last}`, `${last}:evening-update:x`, last, `true_${grp.groupId}_3EB0LASTWK`, "3EB0LASTWK",
        `sn-${grp.matchId}`, `${grp.matchId}:evening-update:x`, grp.matchId, `true_${grp.groupId}_3EB0THISWK`, "3EB0THISWK",
      ],
    );
    await grp.postBatch([{ player: "dan", body: "IN", route: "self_att", facts: IN, quote: { id: "3EB0LASTWK", text: "Squad for last week", fromMatchTime: true } }]);
    expect(await grp.attendanceOf("dan"), "nothing written to this match").toBeNull();
    expect(await grp.attendanceOf("dan", last), "nor to last week's").toBeNull();

    await grp.postBatch([{ player: "dan", body: "IN", route: "self_att", facts: IN, quote: { id: "3EB0THISWK", text: "Squad for this week", fromMatchTime: true } }]);
    expect((await grp.attendanceOf("dan"))?.status).toBe("CONFIRMED");
  });

  test("MatchTime's in-group reply is claimed, keyed for the Pi, and the ack stamps its stanza id", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 14, attendance: [{ key: "owner", status: "CONFIRMED" }] })).attach(request);
    const COUNT = { topic: "count", personRef: "", statedCount: -1, feature: "none", table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none" };
    const r = await grp.postBatch([{ player: "dan", body: "@Match Time how many are in?", tag: true, route: "question", facts: COUNT }]);
    const res = (r.raw as { results: Array<{ waMessageId: string; reply: string | null; replyKey?: string }> }).results[0];
    expect(res.reply, "the question was answered").toBeTruthy();
    expect(res.replyKey).toBe(`greply:${grp.orgId}:${res.waMessageId}`);
    const row = await db.one<{ kind: string; matchId: string | null; text: string | null }>(`SELECT kind, "matchId", text FROM "SentNotification" WHERE key = $1`, [res.replyKey]);
    expect(row).toMatchObject({ kind: "group-reply", matchId: grp.matchId, text: res.reply });

    const ack = await request.post("/api/whatsapp/ack", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { key: res.replyKey, kind: "group-reply", waMessageId: `true_${grp.groupId}_3EB0MTREPLY` },
    });
    expect(ack.status()).toBe(200);
    expect(await db.one<{ waStanzaId: string }>(`SELECT "waStanzaId" FROM "SentNotification" WHERE key = $1`, [res.replyKey])).toEqual({ waStanzaId: "3EB0MTREPLY" });
  });

  test("a quote of a member the route could not resolve names nobody: \"he's out\" drops no one", async ({ request, db }) => {
    const grp = (await createGroup(request, db, { maxPlayers: 14, attendance: [{ key: "owner", status: "CONFIRMED" }, { key: "pete", status: "CONFIRMED" }] })).attach(request);
    // An outsider calling themselves "Pete Power" on WhatsApp; nothing stored.
    await grp.postBatch([
      {
        player: "owner",
        body: "@Match Time he's out",
        tag: true,
        route: "other_att",
        facts: facts([claim({ subject: "other", personRef: "he", personNamed: false, polarity: "out" })]),
        quote: { id: "3EB0NOBODY", text: "I'm out", fromMatchTime: false },
      },
    ]);
    expect((await grp.attendanceOf("pete"))?.status).toBe("CONFIRMED");
  });
});
