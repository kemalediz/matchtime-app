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
import { deflateSync } from "node:zlib";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn } from "../helpers/stub";
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

// ── A club's own graphics template ──────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A plain dark PNG: a stand-in background with no club's branding on it. */
function plainPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x18)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const TEMPLATE_W = 400;
const TEMPLATE_H = 700;
/** Two rows a column: a 2 v 2 team sheet fits it exactly. */
const TEMPLATE_LAYOUT = {
  version: 1,
  width: TEMPLATE_W,
  height: TEMPLATE_H,
  rows: [300, 360],
  capHeight: 20,
  name: { colour: "#ffffff", maxFontSize: 30, minFontSize: 18 },
  columns: [
    { nameX: 60, maxWidth: 130, iconCentreX: 30, badgeColour: "#000000" },
    { nameX: 260, maxWidth: 130, iconCentreX: 230, badgeColour: "#ffffff" },
  ],
  date: { x: 250, centreY: 40, fontSize: 16, colour: "#ffffff", maxWidth: 140 },
  time: { x: 250, centreY: 70, fontSize: 16, colour: "#ffffff", maxWidth: 140 },
  squadHeader: { panel: { x: 20, y: 150, width: 360, height: 80 }, from: "#eeeeee", to: "#ff1493", titleColour: "#000000", titleFontSize: 40, keep: [{ x: 20, y: 150, width: 60, height: 80 }] },
  reserves: { centreX: 200, centreY: 420, fontSize: 14, colour: "#ffffff", maxWidth: 360 },
};

async function pngSize(res: { body(): Promise<Buffer> }): Promise<[number, number]> {
  const body = await res.body();
  expect([...body.subarray(0, 4)]).toEqual(PNG_MAGIC);
  return [body.readUInt32BE(16), body.readUInt32BE(20)];
}

test.describe("GET /api/graphics/<token> for a club with its own template", () => {
  test.beforeAll(async ({ db }) => {
    await db.run(
      `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, "updatedAt") VALUES ($1, $2, 'image/png', $3::jsonb, now())`,
      [ORG_ID, plainPng(TEMPLATE_W, TEMPLATE_H), JSON.stringify(TEMPLATE_LAYOUT)],
    );
  });

  test.afterAll(async ({ db }) => {
    await db.run(`DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID]);
    await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  });

  test("the list poster is drawn on the template: a PNG at the template's size", async ({ request }) => {
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await pngSize(res)).toEqual([TEMPLATE_W, TEMPLATE_H]);
  });

  test("a team sheet whose teams fill the template's rows: drawn on the template", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES
         ('e2e-tt-1', $1, $2, 'RED'), ('e2e-tt-2', $1, $3, 'YELLOW'), ('e2e-tt-3', $1, $4, 'RED'), ('e2e-tt-4', $1, $5, 'YELLOW')`,
      [MATCH.upcoming, U.admin, U.collector, U.player, U.third],
    );
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "teams" })}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(await pngSize(res)).toEqual([TEMPLATE_W, TEMPLATE_H]);
  });

  test("teams that do not fill its rows (3 v 1): the default design instead, 1080 x 1350", async ({ request, db }) => {
    await db.run(`UPDATE "TeamAssignment" SET team = 'RED' WHERE id = 'e2e-tt-2'`);
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "teams" })}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(await pngSize(res)).toEqual([1080, 1350]);
  });

  test("a stored layout the renderer cannot draw: the default design, never an error", async ({ request, db }) => {
    await db.run(`UPDATE "ClubGraphicsTemplate" SET layout = '{"version": 99}'::jsonb WHERE "orgId" = $1`, [ORG_ID]);
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(await pngSize(res)).toEqual([1080, 1350]);
  });

  test("another club's template is never used: no template of its own, the default design", async ({ request, db }) => {
    await db.run(`DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID]);
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "createdAt", "updatedAt") VALUES ('e2e-org-tpl', 'Other FC', 'e2e-other-fc-tpl', 'e2e-invite-tpl', now(), now())`,
    );
    await db.run(
      `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, "updatedAt") VALUES ('e2e-org-tpl', $1, 'image/png', $2::jsonb, now())`,
      [plainPng(TEMPLATE_W, TEMPLATE_H), JSON.stringify(TEMPLATE_LAYOUT)],
    );
    const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`);
    expect(res.status()).toBe(200);
    expect(await pngSize(res)).toEqual([1080, 1350]);
    // Deleting the club deletes its template.
    await db.run(`DELETE FROM "Organisation" WHERE id = 'e2e-org-tpl'`);
    expect(await db.all(`SELECT 1 FROM "ClubGraphicsTemplate" WHERE "orgId" = 'e2e-org-tpl'`)).toHaveLength(0);
  });
});

test.describe("the admin-group request", () => {
  // Since 2026-10-16 the request is read by the SHARED router (stubbed
  // here: what the model would have said), in the admins' own words.
  test.beforeEach(() =>
    engineOn({
      poster: { route: "poster" },
      "can you do the poster for this week": { route: "poster" },
      "team sheet": { route: "team_sheet" },
      "takım listesi": { route: "team_sheet" },
    }),
  );
  test.afterAll(() => clearPipelineStubs());

  // 2026-10-16 (Kemal): anyone in HQ may ask for a graphic, as for a
  // question; only what changes the club is the organisers'. Before any
  // teams, so no job is queued and the counts below stand.
  test("a non-admin's 'team sheet' is answered too: 'No teams yet.', no job", async ({ request, db }) => {
    const out = await say(request, "team sheet", PLAYER);
    expect(out).toMatchObject({ handled: true, outcome: "graphic-no-teams", replyText: "No teams yet." });
    expect(await graphicJobs(db)).toHaveLength(0);
  });

  test("'team sheet' before any teams: 'No teams yet.', no job", async ({ request, db }) => {
    expect(await say(request, "team sheet")).toMatchObject({ handled: true, outcome: "graphic-no-teams", replyText: "No teams yet." });
    expect(await graphicJobs(db)).toHaveLength(0);
  });

  test("an admin's 'can you do the poster for this week': a graphic job, emitted with a signed image URL the Pi can fetch", async ({ request, db }) => {
    const out = await say(request, "can you do the poster for this week");
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

// ── One team sheet per set of teams (2026-10-30) ───────────────────────
//
// 29 Oct, FNF HQ: the team sheet went out twice in a row with the same
// teams (the approval's sheet and an asked one due on the same poll; an
// asked one and the redraw still in its quiet period). Through the real
// routes: due-posts emits, the Pi's fetch of /api/graphics/<token> records
// what the sheet showed, and the next poll does not send the same teams.
test.describe("one team sheet per set of teams", () => {
  const SHEET = ["graphic:v1", "teams", MATCH.upcoming];
  const POLL_HEADERS = { ...KEY, "x-mt-pi-caps": "admin-group" };

  const queueSheet = (db: TestDb, id: string, how: "auto" | "asked") =>
    db.run(
      `INSERT INTO "BotJob" (id, "orgId", kind, text, "pollOptions", "createdAt") VALUES ($1, $2, 'admin-group', 'Ready to post', $3, now())`,
      [id, ORG_ID, [...SHEET, how]],
    );

  /** One due-posts poll, claiming as the Pi's does; the team sheet instructions in it. */
  async function pollSheets(request: APIRequestContext) {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers: POLL_HEADERS });
    expect(res.status(), await res.text()).toBe(200);
    const all = (await res.json()).instructions as Array<{ key: string; kind: string; imageUrl?: string }>;
    return all.filter((i) => i.kind === "admin-group-message" && typeof i.imageUrl === "string" && i.imageUrl.includes("/api/graphics/"));
  }

  /** What the Pi does with one: fetch the image, post it, ack. */
  async function piSends(request: APIRequestContext, instr: { key: string; kind: string; imageUrl?: string }, n: number) {
    const img = await request.get(new URL(instr.imageUrl!).pathname);
    expect(img.status()).toBe(200);
    const ack = await request.post("/api/whatsapp/ack", { headers: KEY, data: { key: instr.key, kind: instr.kind, matchId: MATCH.upcoming, waMessageId: `wa-sheet-${n}` } });
    expect(ack.status()).toBe(200);
  }

  const job = async (db: TestDb, id: string) =>
    (await db.all<{ sentAt: Date | null; pollOptions: string[] }>(`SELECT "sentAt", "pollOptions" FROM "BotJob" WHERE id = $1`, [id]))[0];

  test.beforeAll(async ({ db }) => {
    await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1 AND "pollOptions"[1] = 'graphic:v1'`, [ORG_ID]);
    // Off, so a trigger's sheet is due whatever the hour the suite runs.
    await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [ORG_ID]);
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES
         ('e2e-ts-1', $1, $2, 'RED'), ('e2e-ts-2', $1, $3, 'YELLOW'), ('e2e-ts-3', $1, $4, 'RED'), ('e2e-ts-4', $1, $5, 'YELLOW')`,
      [MATCH.upcoming, U.admin, U.collector, U.player, U.third],
    );
  });
  test.beforeEach(() => engineOn({ "team sheet": { route: "team_sheet" }, "takım listesi": { route: "team_sheet" } }));
  test.afterAll(async ({ db }) => {
    clearPipelineStubs();
    await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
    await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true WHERE id = $1`, [ORG_ID]);
  });

  test("the approval's sheet and an asked one due together: one image; the rest closed unsent; a request minutes later: one short line", async ({ request, db }) => {
    // 18:09 on 29 Oct: both due on the same poll.
    await queueSheet(db, "e2e-sheet-auto", "auto");
    await queueSheet(db, "e2e-sheet-asked", "asked");
    const first = await pollSheets(request);
    expect(first.map((i) => i.key)).toEqual(["botjob-e2e-sheet-auto"]);
    await piSends(request, first[0], 1);

    // The next poll: the asked one shows the same teams, drawn seconds ago.
    expect(await pollSheets(request)).toEqual([]);
    expect(await job(db, "e2e-sheet-asked")).toMatchObject({ sentAt: expect.any(Date), pollOptions: [...SHEET, "asked", "skipped:same-teams"] });

    // A redraw whose changes cancelled out: never sent.
    await queueSheet(db, "e2e-sheet-redraw", "auto");
    expect(await pollSheets(request)).toEqual([]);
    expect((await job(db, "e2e-sheet-redraw")).pollOptions).toContain("skipped:same-teams");

    // Asked for again within 10 minutes: one line, no job.
    expect(await say(request, "team sheet")).toMatchObject({
      handled: true,
      outcome: "graphic-unchanged",
      replyText: "The teams have not changed since the team sheet I just posted.",
    });
    expect((await graphicJobs(db)).filter((j) => !j.sentAt)).toHaveLength(0);
  });

  test("the teams changed: asked for, the new sheet goes at once", async ({ request, db }) => {
    await db.run(`UPDATE "TeamAssignment" SET team = 'YELLOW' WHERE id = 'e2e-ts-1'`);
    await db.run(`UPDATE "TeamAssignment" SET team = 'RED' WHERE id = 'e2e-ts-2'`);
    expect(await say(request, "team sheet")).toMatchObject({ handled: true, outcome: "graphic-queued", replyText: null });
    const sheets = await pollSheets(request);
    expect(sheets).toHaveLength(1);
    await piSends(request, sheets[0], 2);
    expect(await pollSheets(request)).toEqual([]);
  });
});
