/**
 * THE LIST POSTER AND THE TEAM SHEET (2026-10-14), against a real Postgres
 * and the real routes. No model anywhere on this path.
 *
 *   - GET /api/graphics/<token>: a PNG for a good token; 404 for a forged,
 *     expired or junk one, for a match at another club, and for teams that
 *     do not exist yet.
 *   - "poster" / "team sheet" from an admin in the admin group: a graphic
 *     BotJob, emitted by due-posts as an admin-group-message with a signed
 *     imageUrl the Pi can fetch.
 *
 * The fixture club (E2E Test FC) has its upcoming match at 4 of 5 with Ben
 * Bench on the bench. Alex Admin is the OWNER.
 *
 * Tokens are minted here with node:crypto in the shipped format
 * (src/lib/graphic-token.ts), which pins that format from the outside.
 */
import { createHmac } from "node:crypto";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000041@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function token(p: { o: string; m: string; k: string }, ttlSeconds = 900, iat = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify({ ...p, iat, exp: iat + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", E2E.AUTH_SECRET).update(`matchtime-graphic-v1.${body}`).digest("base64url");
  return `${body}.${sig}`;
}

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agg-${++seq}`, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const graphicJobs = (db: TestDb) =>
  db.all<{ id: string; text: string; pollOptions: string[]; sentAt: Date | null }>(
    `SELECT id, text, "pollOptions", "sentAt" FROM "BotJob" WHERE "orgId" = $1 AND kind = 'admin-group' AND "pollOptions"[1] = 'graphic:v1' ORDER BY "createdAt"`,
    [ORG_ID],
  );

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
});

test.afterAll(() => {
  resetDb();
});

test.describe("GET /api/graphics/<token>", () => {
  test("a good list token: a 1080 x 1350 PNG, not cached", async ({ request }) => {
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = await res.body();
    expect([...body.subarray(0, 4)]).toEqual(PNG_MAGIC);
    // IHDR: width and height, big-endian, at bytes 16..24.
    expect(body.readUInt32BE(16)).toBe(1080);
    expect(body.readUInt32BE(20)).toBe(1350);
  });

  test("junk, forged, expired, too long-lived, or another club's: 404, the same answer", async ({ request }) => {
    const good = token({ o: ORG_ID, m: MATCH.upcoming, k: "list" });
    const [body, sig] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ o: ORG_ID, m: MATCH.upcoming, k: "list", iat: 1, exp: 9999999999 })).toString("base64url");
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    for (const t of [
      "junk",
      `${body}.${sig.slice(0, -3)}abc`,
      `${forgedBody}.${sig}`,
      token({ o: ORG_ID, m: MATCH.upcoming, k: "list" }, 900, longAgo),
      token({ o: ORG_ID, m: MATCH.upcoming, k: "list" }, 7 * 24 * 3600),
      token({ o: "another-org", m: MATCH.upcoming, k: "list" }),
      token({ o: ORG_ID, m: MATCH.upcoming, k: "ratings" }),
    ]) {
      const res = await request.get(`/api/graphics/${t}`);
      expect(res.status(), t).toBe(404);
    }
  });

  test("the team sheet: 404 until the teams exist, then a PNG", async ({ request, db }) => {
    const t = token({ o: ORG_ID, m: MATCH.upcoming, k: "teams" });
    expect((await request.get(`/api/graphics/${t}`)).status()).toBe(404);
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES
         ('e2e-ta-1', $1, $2, 'RED'), ('e2e-ta-2', $1, $3, 'YELLOW'), ('e2e-ta-3', $1, $4, 'RED'), ('e2e-ta-4', $1, $5, 'YELLOW')`,
      [MATCH.upcoming, U.admin, U.collector, U.player, U.third],
    );
    const res = await request.get(`/api/graphics/${t}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect([...(await res.body()).subarray(0, 4)]).toEqual(PNG_MAGIC);
    await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  });
});

test.describe("the admin-group command", () => {
  test("a non-admin's 'poster' is ignored: no reply, no job", async ({ request, db }) => {
    const out = await say(request, "poster", PLAYER);
    expect(out).toMatchObject({ handled: false, replyText: null });
    expect(await graphicJobs(db)).toHaveLength(0);
  });

  test("'team sheet' before any teams: 'No teams yet.', no job", async ({ request, db }) => {
    expect(await say(request, "team sheet")).toMatchObject({ handled: true, outcome: "graphic-no-teams", replyText: "No teams yet." });
    expect(await graphicJobs(db)).toHaveLength(0);
  });

  test("an admin's 'poster': a graphic job, emitted with a signed image URL the Pi can fetch", async ({ request, db }) => {
    const out = await say(request, "poster");
    expect(out).toMatchObject({ handled: true, outcome: "graphic-queued", replyText: null });

    const jobs = await graphicJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].text).toMatch(/^Ready to post: E2E Test FC list for \w{3} \d{1,2} \w{3}$/);
    expect(jobs[0].pollOptions).toEqual(["graphic:v1", "list", MATCH.upcoming, "asked"]);

    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
      headers: { ...KEY, "x-no-claim": "1", "x-mt-pi-caps": "admin-group" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const instructions = (await res.json()).instructions as Array<Record<string, unknown>>;
    const instr = instructions.find((i) => i.key === `botjob-${jobs[0].id}`);
    expect(instr).toMatchObject({ kind: "admin-group-message", groupId: HQ, text: jobs[0].text, matchId: MATCH.upcoming });
    const url = new URL(String(instr!.imageUrl));
    expect(url.pathname).toMatch(/^\/api\/graphics\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // What the Pi does next: fetch it, with no key and no session.
    const img = await request.get(url.pathname);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toBe("image/png");
  });

  test("'takım listesi' with teams made: the team sheet is queued", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ('e2e-ta-5', $1, $2, 'RED'), ('e2e-ta-6', $1, $3, 'YELLOW')`,
      [MATCH.upcoming, U.admin, U.collector],
    );
    expect(await say(request, "takım listesi")).toMatchObject({ handled: true, outcome: "graphic-queued", replyText: null });
    const jobs = await graphicJobs(db);
    expect(jobs.at(-1)!.pollOptions).toEqual(["graphic:v1", "teams", MATCH.upcoming, "asked"]);
    await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  });
});
