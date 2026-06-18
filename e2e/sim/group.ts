/**
 * Virtual WhatsApp-group simulator for the MatchTime bot.
 *
 * Spins up a fresh org + WhatsApp group + roster + match(es) directly in
 * the ISOLATED e2e database (plain SQL via the pg helper — no Prisma in
 * the Playwright process), then lets a spec "be" the group:
 *
 *   const g = await createGroup(request, db, { maxPlayers: 8, ... });
 *   const r = await g.post("pete", "in");           // real analyze pipeline
 *   r.react / r.reply / r.groupPosts / r.dms        // what the bot did
 *   await g.confirmed() / g.bench() / g.dropped()   // DB end-state
 *
 * Determinism: the LLM is stubbed (MT_TEST_LLM_STUB_FILE — same seam the
 * api/ specs use). `post()` either takes an explicit verdict (what the
 * model WOULD have emitted) or infers one for trivial "in"/"out" bodies;
 * everything after the verdict is the REAL deterministic server logic —
 * apply paths, capacity, bench offers, guards, count/prose
 * reconciliation, outbound BotJobs — which is exactly what the suite is
 * meant to regression-net.
 *
 * No WhatsApp, no Anthropic, no network beyond the local Next server.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { TestDb } from "../helpers/test-db";
import { E2E } from "../helpers/env";
import { setLlmStub, type StubVerdict } from "../helpers/stub";
import { londonAt } from "../helpers/constants";

export type { StubVerdict };

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

// Opt-in "live LLM" mode: when MT_SIM_LIVE_LLM=1 the harness skips the
// deterministic stub so the real Anthropic model drives the verdict. Default
// (flag OFF) keeps the stubbed, byte-identical behaviour described above.
const LIVE_LLM = process.env.MT_SIM_LIVE_LLM === "1";

// Per-process uniqueness: ids/phones can never collide across groups or
// spec files, even without a reseed.
const RUN = Date.now().toString(36);
let groupSeq = 0;
let msgSeq = 0;
let phoneSeq = 0;

/** Fresh fictitious UK mobile, outside every range the fixture seed and
 *  api/ specs use (they sit in +44770090xxxx; we allocate 91xxxx). */
export function nextSimPhone(): string {
  return `+4477009${(10000 + phoneSeq++).toString()}`;
}

export function nextMsgId(): string {
  return `sim-${RUN}-${++msgSeq}`;
}

// ── Roster ─────────────────────────────────────────────────────────────

export interface SimPlayerSpec {
  /** Handle used by the spec ("owner", "pete", …). */
  key: string;
  name: string;
  role?: "OWNER" | "ADMIN" | "PLAYER";
  /** false → no phone on record (Gary-Guest shape). Default true. */
  hasPhone?: boolean;
  /** true → sends messages @lid-style: empty authorPhone, resolved by
   *  pushname only. Implies no phone on record. */
  lid?: boolean;
}

export interface SimPlayer {
  key: string;
  userId: string;
  name: string;
  phone: string | null;
  role: "OWNER" | "ADMIN" | "PLAYER";
  lid: boolean;
}

/** Realistic default mix: 16 members with phones (1 owner + 2 admins +
 *  13 players), 2 without a number on record, 1 @lid-only member.
 *  First names are deliberately non-overlapping so name-based fuzzy
 *  resolution stays unique. */
export function defaultRoster(): SimPlayerSpec[] {
  return [
    { key: "owner", name: "Oscar Owner", role: "OWNER" },
    { key: "alice", name: "Alice Admin", role: "ADMIN" },
    { key: "brian", name: "Brian Boss", role: "ADMIN" },
    { key: "pete", name: "Pete Power" },
    { key: "dan", name: "Dan Drummer" },
    { key: "felix", name: "Felix Fox" },
    { key: "greg", name: "Greg Gale" },
    { key: "henry", name: "Henry Hill" },
    { key: "ivan", name: "Ivan Ice" },
    { key: "jake", name: "Jake Jolly" },
    { key: "kyle", name: "Kyle King" },
    { key: "liam", name: "Liam Lake" },
    { key: "mike", name: "Mike Moon" },
    { key: "noah", name: "Noah North" },
    { key: "quinn", name: "Quinn Quick" },
    { key: "ryan", name: "Ryan Reef" },
    { key: "gary", name: "Gary Guest", hasPhone: false },
    { key: "walt", name: "Walt Webless", hasPhone: false },
    { key: "larry", name: "Larry Lid", lid: true },
  ];
}

// ── Group creation ─────────────────────────────────────────────────────

export type AttStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface CompletedMatchSpec {
  /** Days before today; kickoff 20:00 London. Default 1. */
  daysAgo?: number;
  confirmedKeys: string[];
  /** null scores = unscored (waiting for a score). Default 3–2. */
  redScore?: number | null;
  yellowScore?: number | null;
  status?: "COMPLETED" | "TEAMS_PUBLISHED";
  /** key → team, for Elo / rating flows. */
  teams?: Record<string, "RED" | "YELLOW">;
  postMatchEndFlow?: boolean;
}

export interface CreateGroupOpts {
  name?: string;
  maxPlayers?: number;
  players?: SimPlayerSpec[];
  /** Org feature flags; unset = the org defaults (everything on except
   *  paymentTracking + squadFromList). */
  features?: Partial<{
    attendance: boolean;
    bench: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    reminders: boolean;
    statsQa: boolean;
    squadFromList: boolean;
    paymentTracking: boolean;
  }>;
  /** Sport-level team display labels (index 0 → RED, 1 → YELLOW). */
  sportTeamLabels?: [string, string];
  /** false → no upcoming match at all. Default: +2 days, 20:00 London. */
  upcomingMatch?: { daysFromNow?: number } | false;
  /** Initial attendance on the upcoming match. */
  attendance?: Array<{ key: string; status: AttStatus }>;
  completedMatch?: CompletedMatchSpec;
}

export async function createGroup(
  request: APIRequestContext,
  db: TestDb,
  opts: CreateGroupOpts = {},
): Promise<SimGroup> {
  const nonce = `${RUN}-${++groupSeq}`;
  const orgId = `sim-org-${nonce}`;
  const groupId = `sim-group-${nonce}@g.us`;
  const sportId = `sim-sport-${nonce}`;
  const activityId = `sim-activity-${nonce}`;
  const name = opts.name ?? `Sim United ${groupSeq}`;
  const maxPlayers = opts.maxPlayers ?? 14;
  const f = opts.features ?? {};

  // Players first (org membership references them).
  const players = new Map<string, SimPlayer>();
  for (const spec of opts.players ?? defaultRoster()) {
    const userId = `sim-u-${nonce}-${spec.key}`;
    const lid = spec.lid === true;
    const phone = lid || spec.hasPhone === false ? null : nextSimPhone();
    await db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", "seedRating", onboarded, "isActive", "updatedAt")
       VALUES ($1, $2, $3, $4, 6, true, true, now())`,
      [userId, spec.name, `sim-${spec.key}-${nonce}@e2e-test.invalid`, phone],
    );
    players.set(spec.key, {
      key: spec.key,
      userId,
      name: spec.name,
      phone,
      role: spec.role ?? "PLAYER",
      lid,
    });
  }

  await db.run(
    `INSERT INTO "Organisation" (
       id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
       "paymentTrackingEnabled",
       "featureAttendance", "featureBench", "featureTeamBalancing",
       "featureMomVoting", "featurePlayerRating", "featureReminders",
       "featureStatsQa", "featureSquadFromList", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
    [
      orgId,
      name,
      `sim-${nonce}`,
      `sim-invite-${nonce}`,
      groupId,
      f.paymentTracking ?? false,
      f.attendance ?? true,
      f.bench ?? true,
      f.teamBalancing ?? true,
      f.momVoting ?? true,
      f.playerRating ?? true,
      f.reminders ?? true,
      f.statsQa ?? true,
      f.squadFromList ?? false,
    ],
  );

  for (const p of players.values()) {
    await db.run(
      `INSERT INTO "Membership" (id, "userId", "orgId", role)
       VALUES ($1, $2, $3, $4)`,
      [`sim-mem-${nonce}-${p.key}`, p.userId, orgId, p.role],
    );
  }

  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, preset, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football', 'football-7aside', $3, $4, $5, now())`,
    [
      sportId,
      orgId,
      Math.max(2, Math.floor(maxPlayers / 2)),
      ["GK", "DEF", "MID", "FWD"],
      opts.sportTeamLabels ?? ["Red", "Yellow"],
    ],
  );

  const upDate = opts.upcomingMatch === false ? null : londonAt(opts.upcomingMatch?.daysFromNow ?? 2, 20, 0);
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, '20:00', 'Sim Arena', now())`,
    [activityId, orgId, sportId, name, (upDate ?? new Date()).getUTCDay()],
  );

  let matchId: string | null = null;
  if (upDate) {
    matchId = `sim-match-${nonce}`;
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
       VALUES ($1, $2, $3, $4, 'UPCOMING', $5, now())`,
      [matchId, activityId, upDate, maxPlayers, new Date(upDate.getTime() - 5 * 60 * 60 * 1000)],
    );
    let pos = 0;
    for (const a of opts.attendance ?? []) {
      const p = players.get(a.key);
      if (!p) throw new Error(`attendance: unknown player key "${a.key}"`);
      await db.run(
        `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        [`sim-att-${nonce}-${a.key}`, matchId, p.userId, a.status, ++pos],
      );
    }
  }

  let completedMatchId: string | null = null;
  if (opts.completedMatch) {
    const cm = opts.completedMatch;
    completedMatchId = `sim-cmatch-${nonce}`;
    const cmDate = londonAt(-(cm.daysAgo ?? 1), 20, 0);
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                            "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        completedMatchId,
        activityId,
        cmDate,
        maxPlayers,
        cm.status ?? "COMPLETED",
        new Date(cmDate.getTime() - 5 * 60 * 60 * 1000),
        cm.redScore === undefined ? 3 : cm.redScore,
        cm.yellowScore === undefined ? 2 : cm.yellowScore,
        cm.postMatchEndFlow ?? true,
      ],
    );
    let pos = 0;
    for (const key of cm.confirmedKeys) {
      const p = players.get(key);
      if (!p) throw new Error(`completedMatch: unknown player key "${key}"`);
      await db.run(
        `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
         VALUES ($1, $2, $3, 'CONFIRMED', $4, now())`,
        [`sim-catt-${nonce}-${key}`, completedMatchId, p.userId, ++pos],
      );
    }
    for (const [key, team] of Object.entries(cm.teams ?? {})) {
      const p = players.get(key);
      if (!p) throw new Error(`completedMatch.teams: unknown player key "${key}"`);
      await db.run(
        `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team)
         VALUES ($1, $2, $3, $4)`,
        [`sim-cta-${nonce}-${key}`, completedMatchId, p.userId, team],
      );
    }
  }

  const g = new SimGroup(request, db, {
    orgId,
    groupId,
    sportId,
    activityId,
    matchId,
    completedMatchId,
    maxPlayers,
    players,
  });
  await g.drainOutbound(); // baseline (no jobs yet, but keep the contract)
  return g;
}

// ── Default-verdict inference for trivial bodies ───────────────────────

export function inferVerdict(body: string): StubVerdict | undefined {
  const t = body.trim().toLowerCase().replace(/[!.\s]+$/g, "");
  if (/^(in|i'?m in|count me in|in please|yes,? i'?m in)$/.test(t)) {
    return { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "sim default: plain IN" };
  }
  if (/^(out|i'?m out|count me out|can'?t make it|sorry,? (i'?m )?out)$/.test(t)) {
    return { intent: "out", registerAttendance: "OUT", react: "👋", confidence: 0.95, reasoning: "sim default: plain OUT" };
  }
  return undefined; // stub default = noise (bot stays silent)
}

// ── Result shapes ──────────────────────────────────────────────────────

export interface SimMessageResult {
  waMessageId: string;
  handledBy: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
}

export interface SimOutbound {
  /** kind="group" / "group-poll" BotJobs queued during the call. */
  groupPosts: string[];
  /** kind="dm" BotJobs queued during the call. */
  dms: Array<{ phone: string | null; text: string }>;
}

export interface SimPostResult extends SimMessageResult, SimOutbound {
  raw: unknown;
}

export interface SimBatchResult extends SimOutbound {
  results: SimMessageResult[];
  raw: unknown;
}

export interface BatchItem {
  /** Player key, or omit and pass `author` for an unknown sender. */
  player?: string;
  body: string;
  verdict?: StubVerdict;
  author?: { name: string | null; phone: string };
}

// ── The group itself ───────────────────────────────────────────────────

export class SimGroup {
  readonly orgId: string;
  readonly groupId: string;
  readonly sportId: string;
  readonly activityId: string;
  /** The upcoming match (null when created with upcomingMatch:false). */
  readonly matchId: string | null;
  readonly completedMatchId: string | null;
  readonly maxPlayers: number;
  readonly db: TestDb;

  private request: APIRequestContext;
  private readonly players: Map<string, SimPlayer>;
  private readonly seenBotJobIds = new Set<string>();

  constructor(
    request: APIRequestContext,
    db: TestDb,
    init: {
      orgId: string;
      groupId: string;
      sportId: string;
      activityId: string;
      matchId: string | null;
      completedMatchId: string | null;
      maxPlayers: number;
      players: Map<string, SimPlayer>;
    },
  ) {
    this.request = request;
    this.db = db;
    this.orgId = init.orgId;
    this.groupId = init.groupId;
    this.sportId = init.sportId;
    this.activityId = init.activityId;
    this.matchId = init.matchId;
    this.completedMatchId = init.completedMatchId;
    this.maxPlayers = init.maxPlayers;
    this.players = init.players;
  }

  /** Playwright's `request` fixture is per-test; a SimGroup shared
   *  across serial tests must re-attach the CURRENT test's context
   *  before each use (the old one is disposed when its test ends). */
  attach(request: APIRequestContext): this {
    this.request = request;
    return this;
  }

  player(key: string): SimPlayer {
    const p = this.players.get(key);
    if (!p) throw new Error(`sim: unknown player key "${key}"`);
    return p;
  }

  /** Drain BotJobs created since the last drain (any kind). */
  async drainOutbound(): Promise<SimOutbound> {
    const rows = await this.db.all<{ id: string; kind: string; phone: string | null; text: string }>(
      `SELECT id, kind, phone, text FROM "BotJob" WHERE "orgId" = $1`,
      [this.orgId],
    );
    const fresh = rows.filter((r) => !this.seenBotJobIds.has(r.id));
    for (const r of fresh) this.seenBotJobIds.add(r.id);
    return {
      groupPosts: fresh.filter((r) => r.kind === "group" || r.kind === "group-poll").map((r) => r.text),
      dms: fresh.filter((r) => r.kind === "dm").map((r) => ({ phone: r.phone, text: r.text })),
    };
  }

  /** Send a BATCH of group messages through the real analyze pipeline. */
  async postBatch(items: BatchItem[]): Promise<SimBatchResult> {
    const stub: Record<string, StubVerdict> = {};
    const messages = items.map((it) => {
      const id = nextMsgId();
      const v = it.verdict ?? inferVerdict(it.body);
      if (!LIVE_LLM && v) stub[id] = v;
      let authorPhone = "";
      let authorName: string | null = null;
      if (it.author) {
        authorPhone = it.author.phone;
        authorName = it.author.name;
      } else if (it.player) {
        const p = this.player(it.player);
        authorPhone = p.lid || !p.phone ? "" : p.phone.replace(/^\+/, "");
        authorName = p.name;
      }
      return {
        waMessageId: id,
        body: it.body,
        authorPhone,
        authorName,
        timestamp: new Date().toISOString(),
      };
    });
    if (!LIVE_LLM) setLlmStub(stub);
    const res = await this.request.post("/api/whatsapp/analyze", {
      headers: HEADERS,
      data: { groupId: this.groupId, messages },
    });
    expect(res.status(), await res.text()).toBe(200);
    const raw = (await res.json()) as {
      results?: Array<SimMessageResult>;
    };
    const out = await this.drainOutbound();
    const results = messages.map((m) => {
      const r = raw.results?.find((x) => x.waMessageId === m.waMessageId);
      return (
        r ?? { waMessageId: m.waMessageId, handledBy: "missing", intent: null, react: null, reply: null }
      );
    });
    return { results, ...out, raw };
  }

  /** Send ONE group message; returns its result + everything queued. */
  async post(
    playerKey: string | null,
    body: string,
    opts: { verdict?: StubVerdict; author?: { name: string | null; phone: string } } = {},
  ): Promise<SimPostResult> {
    const batch = await this.postBatch([
      { player: playerKey ?? undefined, body, verdict: opts.verdict, author: opts.author },
    ]);
    return { ...batch.results[0], groupPosts: batch.groupPosts, dms: batch.dms, raw: batch.raw };
  }

  /** 1-1 DM to the bot (the Pi forwards these to /api/whatsapp/dm-reply). */
  async dm(playerKey: string, body: string): Promise<{ json: Record<string, unknown> } & SimOutbound> {
    const p = this.player(playerKey);
    const res = await this.request.post("/api/whatsapp/dm-reply", {
      headers: HEADERS,
      data: {
        phone: p.lid || !p.phone ? "" : p.phone.replace(/^\+/, ""),
        body,
        waMessageId: nextMsgId(),
        authorName: p.name,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const out = await this.drainOutbound();
    return { json, ...out };
  }

  /** Reaction on one of the bot's posts (bench-offer claims). */
  async reaction(waMessageId: string, emoji: string, fromKey: string): Promise<Record<string, unknown>> {
    const p = this.player(fromKey);
    const res = await this.request.post("/api/whatsapp/reaction", {
      headers: HEADERS,
      data: {
        waMessageId,
        emoji,
        fromPhone: p.phone ? p.phone.replace(/^\+/, "") : "",
        fromAuthorName: p.name,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Vote in a bot-posted poll (MoM / payment). */
  async pollVote(args: {
    waMessageId: string;
    voterKey: string;
    optionName: string | null;
  }): Promise<Record<string, unknown>> {
    const p = this.player(args.voterKey);
    const res = await this.request.post("/api/whatsapp/poll-vote", {
      headers: HEADERS,
      data: {
        waMessageId: args.waMessageId,
        voterPhone: p.phone ? p.phone.replace(/^\+/, "") : "",
        voterName: p.name,
        optionName: args.optionName,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Scheduler tick at a pinned clock (MT_TEST_MODE x-test-now). */
  async duePosts(now: Date): Promise<Array<{ kind: string; key?: string; targetUser?: string; text?: string }>> {
    const res = await this.request.get(
      `/api/whatsapp/due-posts?groupId=${encodeURIComponent(this.groupId)}`,
      { headers: { ...HEADERS, "x-test-now": now.toISOString() } },
    );
    expect(res.status(), await res.text()).toBe(200);
    const json = (await res.json()) as { instructions?: Array<{ kind: string }> };
    return (json.instructions ?? []) as Array<{ kind: string; key?: string; targetUser?: string; text?: string }>;
  }

  /** The Pi's "bot was added to this group" event, for THIS group id. */
  async botAdded(data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.request.post("/api/whatsapp/bot-added", {
      headers: HEADERS,
      data: { groupId: this.groupId, ...data },
    });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  // ── DB end-state helpers (upcoming match unless told otherwise) ──────

  private requireMatch(matchId?: string): string {
    const id = matchId ?? this.matchId;
    if (!id) throw new Error("sim: group has no upcoming match");
    return id;
  }

  private async names(status: AttStatus, matchId?: string): Promise<string[]> {
    const rows = await this.db.all<{ name: string | null }>(
      `SELECT u.name FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
       WHERE a."matchId" = $1 AND a.status = $2 ORDER BY a.position ASC`,
      [this.requireMatch(matchId), status],
    );
    return rows.map((r) => r.name ?? "(unnamed)");
  }

  confirmed(matchId?: string): Promise<string[]> {
    return this.names("CONFIRMED", matchId);
  }

  bench(matchId?: string): Promise<string[]> {
    return this.names("BENCH", matchId);
  }

  dropped(matchId?: string): Promise<string[]> {
    return this.names("DROPPED", matchId);
  }

  async counts(matchId?: string): Promise<{ confirmed: number; bench: number; dropped: number; maxPlayers: number }> {
    return {
      confirmed: (await this.confirmed(matchId)).length,
      bench: (await this.bench(matchId)).length,
      dropped: (await this.dropped(matchId)).length,
      maxPlayers: this.maxPlayers,
    };
  }

  async attendanceOf(
    playerKey: string,
    matchId?: string,
  ): Promise<{ status: string; position: number } | null> {
    return this.db.one<{ status: string; position: number }>(
      `SELECT status, position FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [this.requireMatch(matchId), this.player(playerKey).userId],
    );
  }

  /** Directly set attendance (test setup shortcut, not via the bot). */
  async setAttendance(playerKey: string, status: AttStatus, matchId?: string): Promise<void> {
    const mid = this.requireMatch(matchId);
    const uid = this.player(playerKey).userId;
    const max = await this.db.one<{ max: number | string | null }>(
      `SELECT MAX(position) AS max FROM "Attendance" WHERE "matchId" = $1`,
      [mid],
    );
    const next = Number(max?.max ?? 0) + 1;
    await this.db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT ("matchId", "userId") DO UPDATE SET status = $4`,
      [`sim-satt-${nextMsgId()}`, mid, uid, status, next],
    );
  }

  async openOffers(matchId?: string): Promise<
    Array<{ id: string; replacingUserId: string | null; claimedByUserId: string | null; waMessageId: string | null }>
  > {
    return this.db.all(
      `SELECT id, "replacingUserId", "claimedByUserId", "waMessageId"
       FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL ORDER BY "createdAt" ASC`,
      [this.requireMatch(matchId)],
    );
  }

  async botJobs(kind?: string): Promise<Array<{ kind: string; phone: string | null; text: string }>> {
    return this.db.all(
      `SELECT kind, phone, text FROM "BotJob" WHERE "orgId" = $1 ${kind ? `AND kind = $2` : ""} ORDER BY "createdAt" ASC`,
      kind ? [this.orgId, kind] : [this.orgId],
    );
  }
}

// ── Onboarding-only virtual group (no org exists yet) ──────────────────

export interface OnboardingSimGroup {
  groupId: string;
  botAdded(data?: Record<string, unknown>): Promise<Record<string, unknown>>;
  say(
    body: string,
    author: { phone: string; name?: string | null },
    opts?: {
      enrichmentHistory?: Array<{
        author: string;
        authorPhone?: string | null;
        text: string;
        timestamp: string | number;
      }>;
    },
  ): Promise<{ reply: string | null; raw: unknown }>;
}

/** A brand-new WhatsApp group the bot has just been added to — there is
 *  deliberately NO org/roster; the onboarding flow itself creates them. */
export function createOnboardingGroup(request: APIRequestContext): OnboardingSimGroup {
  const groupId = `sim-onb-${RUN}-${++groupSeq}@g.us`;
  return {
    groupId,
    async botAdded(data = {}) {
      const res = await request.post("/api/whatsapp/bot-added", {
        headers: HEADERS,
        data: { groupId, ...data },
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    },
    async say(body, author, opts) {
      const res = await request.post("/api/whatsapp/analyze", {
        headers: HEADERS,
        data: {
          groupId,
          messages: [
            {
              waMessageId: nextMsgId(),
              body,
              authorPhone: author.phone,
              authorName: author.name ?? null,
              timestamp: new Date().toISOString(),
            },
          ],
          // Only included when a caller passes enrichment history (e.g. on
          // the completing turn); existing callers stay byte-identical.
          ...(opts?.enrichmentHistory
            ? { enrichmentHistory: opts.enrichmentHistory }
            : {}),
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      const json = (await res.json()) as { results?: Array<{ reply: string | null }> };
      return { reply: json.results?.[0]?.reply ?? null, raw: json };
    },
  };
}
