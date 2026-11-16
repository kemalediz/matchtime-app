/**
 * Group simulator: A PLAYER WHO JOINED MOMENTS AGO IS TAGGED BY LID
 * (the Vets, 16 Nov 2026).
 *
 * 18:05 UTC a player was added to the group. `group-join` made his User
 * row from his phone with no name (the Pi knew none) and DMed the admin.
 * At 18:06 the organiser posted "@Match Time ... @<his LID> is IN"; the Pi
 * sent the LID WITH his phone and his WhatsApp name. His own "In" was in
 * the same batch. The mention roster held only members with a name, so
 * the tag stayed raw and the group was asked "who is it?" about a player
 * MatchTime had just added (`mention-roster.ts`).
 *
 * The REAL routes, router and extractor stubbed (no model calls). Every
 * person and number is made up.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup, nextMsgId, nextSimPhone, type SimGroup } from "./group";
import { E2E } from "../helpers/env";
import { otherFacts, selfIn, setExtractorStub, setRouterStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const LID = "246813579024680@lid";
const RAW_TAG = "@Match Time @246813579024680 is IN";
const ASK_WHO = "I couldn't tell who that is, can you say their name?";

/** The Pi's group_join for one new number, no WhatsApp name known. */
async function join(request: APIRequestContext, g: SimGroup, phoneDigits: string) {
  const res = await request.post("/api/whatsapp/group-join", { headers: HEADERS, data: { groupId: g.groupId, phones: [phoneDigits] } });
  expect(res.status(), await res.text()).toBe(200);
  const row = await g.db.one<{ id: string; name: string | null }>(`SELECT id, name FROM "User" WHERE "phoneNumber" = $1`, [`+${phoneDigits}`]);
  expect(row?.name, "joined with no name, as the Vets player did").toBeNull();
  return row!.id;
}

async function statusOf(g: SimGroup, userId: string) {
  return (await g.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [g.matchId, userId]))?.status ?? null;
}

test("joined, then tagged by LID in the organiser's next batch: he is recognised and put IN", async ({ request, db }) => {
  const g = (await createGroup(request, db)).attach(request);
  const phone = nextSimPhone().replace(/^\+/, "");
  const userId = await join(request, g, phone);

  // The organiser's message, as the Pi forwards it: the raw LID token, and
  // beside it his phone and his own WhatsApp profile name (pushname). The extractor is shown the body
  // AFTER naming, so its canned facts are keyed by the named body: on a
  // build that leaves the tag raw it extracts nothing.
  const id = nextMsgId();
  setRouterStub({ floor: false, routes: { [id]: "other_att" } });
  setExtractorStub({ bodies: { "@Match Time @Nico Newman is IN": otherFacts("Nico Newman", "in") } });
  const r = await g.postBatch([
    { waMessageId: id, player: "alice", body: RAW_TAG, tag: true, mentions: [{ jid: LID, name: "Nico Newman", phone, pushname: "Nico Newman" }] },
  ]);

  const stored = await db.one<{ body: string }>(`SELECT body FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [id]);
  expect(stored?.body).toBe("@Match Time @Nico Newman is IN");
  expect(await statusOf(g, userId)).toBe("CONFIRMED");
  expect(r.results[0].reply ?? "").not.toContain(ASK_WHO);
  expect(r.groupPosts.join("\n")).not.toContain(ASK_WHO);
  // His row has the name the group now knows him by.
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [userId]))?.name).toBe("Nico Newman");
});

test("THE VETS SHAPE: his own \"In\" and the organiser's tag in ONE batch, the tag first", async ({ request, db }) => {
  const g = (await createGroup(request, db)).attach(request);
  const phone = nextSimPhone().replace(/^\+/, "");
  const userId = await join(request, g, phone);

  const tagId = nextMsgId();
  const inId = nextMsgId();
  setRouterStub({ floor: false, routes: { [tagId]: "other_att", [inId]: "self_att" } });
  setExtractorStub({ bodies: { "@Match Time @Nico is IN": otherFacts("Nico", "in"), In: selfIn() } });
  const r = await g.postBatch([
    { waMessageId: tagId, player: "alice", body: RAW_TAG, tag: true, mentions: [{ jid: LID, name: "Nico Plumber", phone }] },
    { waMessageId: inId, author: { name: "Nico", phone }, body: "In" },
  ]);

  const stored = await db.one<{ body: string }>(`SELECT body FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [tagId]);
  expect(stored?.body).toBe("@Match Time @Nico is IN");
  expect(await statusOf(g, userId)).toBe("CONFIRMED");
  for (const res of r.results) expect(res.reply ?? "").not.toContain(ASK_WHO);
  expect(r.groupPosts.join("\n")).not.toContain(ASK_WHO);
  // One Nico: no second, provisional member was made from the name.
  expect((await db.all(`SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.name = 'Nico'`, [g.orgId])).length).toBe(1);
});
