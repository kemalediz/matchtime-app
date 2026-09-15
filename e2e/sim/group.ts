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
 * No WhatsApp, no Anthropic, no network beyond the local Next server.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DETERMINISM: A ROUTE AND SOME FACTS, NEVER A VERDICT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * What this said until §10 step 8, and it was true for eighteen months:
 *
 *   "the LLM is stubbed (MT_TEST_LLM_STUB_FILE — same seam the api/
 *    specs use). `post()` either takes an explicit verdict (what the
 *    model WOULD have emitted) or infers one for trivial in/out bodies;
 *    everything after the verdict is the REAL deterministic server
 *    logic."
 *
 * Step 8 deleted `analyzeBatch`, `SYSTEM_PROMPT` and `AnalysisVerdict`,
 * so there was nothing left to read a verdict. `verdict:` and
 * `inferVerdict` are deleted with them. THE SEAM IS NOW TWO FILES, one
 * layer either side of where the verdict used to sit, and a spec reaches
 * both by saying, per message, what the ROUTER answered and what the
 * EXTRACTOR found:
 *
 *   await g.post("pete", "in", { route: "self_att", facts: selfIn() });
 *
 *   await g.postBatch(
 *     [{ player: "alice", body: "@Match Time move Dan to the bench", tag: true,
 *        route: "other_att", facts: otherFacts("Dan", "bench") }],
 *     { floor: true },              // and the step-5 / step-7 knobs
 *   );
 *
 * WHY THAT IS NOT A RENAME OF `verdict:`. A verdict said what to DO —
 * `registerAttendance: "IN"` — and the suite then asserted the write it
 * had just asked for. Facts say only what the message SAID; `polarity`,
 * `tense`, `basis`, `contingent`, `personNamed` and `subject` are all
 * properties of the text, checkable by re-reading it. Whether that
 * becomes a CONFIRMED row, a BENCH row, a name-ask, a tentative or
 * nothing at all is `pipeline/engine.ts`'s decision, made against
 * capacity, the interaction contract, authorisation and the confidence
 * floor. So every ported case pins a decision it used to assume.
 *
 * A body with no `route` is left unmapped, which `gate.ts` falls back to
 * `unsure` — an ENGINE route since step 8 — and an unmapped body has no
 * facts, so nothing is written and nothing is said. That is the
 * direction that cannot invent a write in a spec which never mentioned
 * one.
 *
 * For finer control (a floor override, `engineRoutes`, an injected
 * extractor failure) a spec can still arm `helpers/stub.ts`'s
 * `setRouterStub` / `setExtractorStub` / `engineOn` directly and pass no
 * per-message routing at all; `postBatch` only writes the stub files
 * when the batch itself declares something.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { TestDb } from "../helpers/test-db";
import { E2E } from "../helpers/env";
import { setExtractorStub, setRouterStub } from "../helpers/stub";
import { londonAt } from "../helpers/constants";

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
  /** Exact hours before now — takes precedence over `daysAgo`. Used by
   *  `e2e/replay/` to keep a replayed world's match history the same
   *  distance in the past that it really was. */
  hoursAgo?: number;
  confirmedKeys: string[];
  /** null scores = unscored (waiting for a score). Default 3–2. */
  redScore?: number | null;
  yellowScore?: number | null;
  status?: "COMPLETED" | "TEAMS_PUBLISHED" | "TEAMS_GENERATED";
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
  /**
   * false → no upcoming match at all. Default: +2 days, 20:00 London.
   *
   * `hoursFromNow` takes precedence over `daysFromNow` and places
   * kickoff at an EXACT offset from now rather than at 20:00 on some
   * day. Added for `e2e/replay/`, which replays a real message with the
   * hours-to-kickoff it actually had: two hours before kickoff and two
   * days before are different worlds (deadline, chase, bench offers),
   * and day granularity erases that.
   *
   * `deadlineHoursBeforeKickoff` overrides the historical 5-hour gap —
   * Sutton FC runs `deadlineHours: 0`.
   */
  upcomingMatch?:
    | { daysFromNow?: number; hoursFromNow?: number; deadlineHoursBeforeKickoff?: number }
    | false;
  /** Initial attendance on the upcoming match. */
  attendance?: Array<{ key: string; status: AttStatus }>;
  /**
   * A TEAM SHEET ON THE UPCOMING MATCH, key → team, in the order given.
   *
   * Sets `Match.status = TEAMS_GENERATED` too, because in production the
   * two arrive together (`actions/teams.ts`, `cron/generate-teams`) and a
   * world where one exists without the other is not one the bot can
   * reach. Insertion order matters: `load-state.ts` reads the sheet
   * `id: asc` so a re-post renders the players in the order the balancer
   * wrote them, and the 2026-09-15 slot inherit pairs vacancies in that
   * same order.
   */
  teams?: Record<string, "RED" | "YELLOW">;
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
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
       VALUES ($1, $2, $3, $4, true, true, now())`,
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
      // The 6 used to sit on `User.seedRating`, where nothing had read
      // it since slice 2, so this roster reached the balancer unseeded
      // and every player fell through to the club mean. It belongs on
      // the membership, which is where `generateTeamsForMatch` looks.
      // The same value for everybody keeps the sim deterministic: a
      // uniform prior ranks the roster exactly as a uniform fall-through
      // did, so no sheet moves, but the club-seed lookup is now
      // genuinely exercised instead of always missing.
      `INSERT INTO "Membership" (id, "userId", "orgId", role, "seedRating")
       VALUES ($1, $2, $3, $4, 6)`,
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

  const upDate =
    opts.upcomingMatch === false
      ? null
      : typeof opts.upcomingMatch?.hoursFromNow === "number"
        ? new Date(Date.now() + opts.upcomingMatch.hoursFromNow * 3_600_000)
        : londonAt(opts.upcomingMatch?.daysFromNow ?? 2, 20, 0);
  const deadlineGapMs =
    (opts.upcomingMatch !== false && opts.upcomingMatch?.deadlineHoursBeforeKickoff !== undefined
      ? opts.upcomingMatch.deadlineHoursBeforeKickoff
      : 5) *
    60 *
    60 *
    1000;
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
      [matchId, activityId, upDate, maxPlayers, new Date(upDate.getTime() - deadlineGapMs)],
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
    // The team sheet, if this world has one. Ids are sequential so the
    // `id: asc` read order is the order they were declared.
    let slot = 0;
    for (const [key, team] of Object.entries(opts.teams ?? {})) {
      const p = players.get(key);
      if (!p) throw new Error(`teams: unknown player key "${key}"`);
      await db.run(
        `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team) VALUES ($1, $2, $3, $4)`,
        [`sim-ta-${nonce}-${String(++slot).padStart(3, "0")}`, matchId, p.userId, team],
      );
    }
    if (slot > 0) {
      await db.run(`UPDATE "Match" SET status = 'TEAMS_GENERATED' WHERE id = $1`, [matchId]);
    }
  }

  let completedMatchId: string | null = null;
  if (opts.completedMatch) {
    const cm = opts.completedMatch;
    completedMatchId = `sim-cmatch-${nonce}`;
    const cmDate =
      typeof cm.hoursAgo === "number"
        ? new Date(Date.now() - cm.hoursAgo * 3_600_000)
        : londonAt(-(cm.daysAgo ?? 1), 20, 0);
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
  /** What the ROUTER answered for this message — `self_att`, `other_att`,
   *  `offer`, `question`, `balancer`, `score`, `admin_ops`, `unsure`,
   *  `none`. Omitted → unmapped, which `gate.ts` falls back to `unsure`. */
  route?: string;
  /** The RAW JSON the extractor for that route returned. Build it with
   *  `helpers/stub.ts`'s `selfIn` / `selfOut` / `otherFacts` / `facts` +
   *  `claim`, so `parseFacts` still runs for real. Omitted → the body
   *  extracts nothing, which cannot invent a write. */
  facts?: Record<string, unknown>;
  author?: { name: string | null; phone: string };
  /** Simulate the message @-mentioning the bot ("@Match Time …"). Sets
   *  the structured `botMentioned` signal the interaction-contract gate
   *  reads. Default false/undefined = untagged. `tag` is an alias. */
  botMentioned?: boolean;
  tag?: boolean;
}

/** One line of the "Recent chat history" block the Pi keeps in memory
 *  (last 15 per group) and forwards on every analyze call. The sim
 *  omitted it entirely until 2026-08-31, which made every spec run
 *  against a context-free prompt — real groups NEVER are. */
export interface SimHistoryEntry {
  authorName: string | null;
  body: string;
  /** Default: 10 minutes before now, in list order. */
  timestamp?: string;
}

export interface SimBatchOpts {
  /** Recent chat history to send with the batch (oldest first). */
  history?: SimHistoryEntry[];
  /** Overrides ROUTER_GATE_FLOOR_ENABLED for this request
   *  (`RouterStub.floor`). Default false. */
  floor?: boolean;
  /** Which of §10 step 7's routes this request owns. Omitted → the env
   *  flags, which default ON. `[]` → own nothing, which is the only way
   *  to assert "and this route was not owned". */
  engineRoutes?: string[];
  /** Bodies whose EXTRACTOR CALL fails with a real overload error, after
   *  the SDK's four retries (`ExtractorStub.fail`). */
  extractorFail?: string[];
  /** Every extractor call fails — the total-overload edge. */
  extractorFailAll?: boolean;
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

  /** The roster key a user id belongs to — the inverse of `player()`, so
   *  a DB assertion can be written in the same vocabulary as the setup. */
  keyOf(userId: string): string {
    for (const [key, p] of this.players) if (p.userId === userId) return key;
    throw new Error(`sim: no player for user id "${userId}"`);
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
  async postBatch(items: BatchItem[], opts: SimBatchOpts = {}): Promise<SimBatchResult> {
    // Per-message routing goes in by waMessageId rather than by body, so
    // two messages in one batch can carry the SAME text and still be
    // routed apart — which `router-gate.spec.ts` needs and a body map
    // cannot express. Facts are still keyed by body: that is the seam
    // `extractor-stub.ts` reads (it only ever sees the prompt), and it is
    // why two identical bodies necessarily extract the same facts.
    const routes: Record<string, string> = {};
    const factBodies: Record<string, Record<string, unknown>> = {};
    const messages = items.map((it) => {
      const id = nextMsgId();
      if (it.route) routes[id] = it.route;
      if (it.facts) factBodies[it.body.trim()] = it.facts;
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
      const tagged = it.botMentioned ?? it.tag;
      return {
        waMessageId: id,
        body: it.body,
        authorPhone,
        authorName,
        timestamp: new Date().toISOString(),
        // Only forward the structured signal when the spec set it, so the
        // server's text fallback still exercises on untouched callers.
        ...(typeof tagged === "boolean" ? { botMentioned: tagged } : {}),
      };
    });
    // Arm the two seams ONLY when this batch actually says something
    // about them, and never under MT_SIM_LIVE_LLM=1 (which pins both
    // files empty on purpose, and which `assertSeamMatchesMode` refuses
    // a run for if they are not). A spec that arms `setRouterStub` /
    // `engineOn` itself and passes no per-message routing is therefore
    // left alone, rather than having its carefully-built stub silently
    // overwritten with an empty one on the next `post()`.
    const declaresRouting =
      Object.keys(routes).length > 0 ||
      Object.keys(factBodies).length > 0 ||
      opts.floor !== undefined ||
      opts.engineRoutes !== undefined ||
      opts.extractorFail !== undefined ||
      opts.extractorFailAll !== undefined;
    if (!LIVE_LLM && declaresRouting) {
      setRouterStub({
        floor: opts.floor ?? false,
        ...(opts.engineRoutes ? { engineRoutes: opts.engineRoutes } : {}),
        routes,
      });
      setExtractorStub({
        bodies: factBodies,
        ...(opts.extractorFail ? { fail: opts.extractorFail } : {}),
        ...(opts.extractorFailAll ? { failAll: true } : {}),
      });
    }
    // Oldest first, spaced a minute apart ending 1 minute before now —
    // the same shape the Pi's in-memory buffer produces.
    const history = (opts.history ?? []).map((h, i, arr) => ({
      authorName: h.authorName,
      body: h.body,
      timestamp:
        h.timestamp ?? new Date(Date.now() - (arr.length - i) * 60_000).toISOString(),
    }));
    const res = await this.request.post("/api/whatsapp/analyze", {
      headers: HEADERS,
      data: {
        groupId: this.groupId,
        messages,
        ...(history.length ? { history } : {}),
      },
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
    opts: {
      /** What the ROUTER answered for this message. See `BatchItem`. */
      route?: string;
      /** The RAW JSON its extractor returned. See `BatchItem`. */
      facts?: Record<string, unknown>;
      author?: { name: string | null; phone: string };
      /** Simulate an @Match Time tag (structured botMentioned signal). */
      botMentioned?: boolean;
      tag?: boolean;
      /** Recent chat history to send with this message (oldest first). */
      history?: SimHistoryEntry[];
      /** Overrides ROUTER_GATE_FLOOR_ENABLED for this request. */
      floor?: boolean;
      /** Which step-7 routes this request owns. */
      engineRoutes?: string[];
      /** Make this message's extractor call fail like an overloaded API. */
      extractorFails?: boolean;
    } = {},
  ): Promise<SimPostResult> {
    const batch = await this.postBatch(
      [
        {
          player: playerKey ?? undefined,
          body,
          ...(opts.route ? { route: opts.route } : {}),
          ...(opts.facts ? { facts: opts.facts } : {}),
          author: opts.author,
          botMentioned: opts.botMentioned,
          tag: opts.tag,
        },
      ],
      {
        history: opts.history,
        ...(opts.floor !== undefined ? { floor: opts.floor } : {}),
        ...(opts.engineRoutes !== undefined ? { engineRoutes: opts.engineRoutes } : {}),
        ...(opts.extractorFails ? { extractorFail: [body.trim()] } : {}),
      },
    );
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
  async duePosts(
    now: Date,
    /** Claim-on-dispatch (2026-07-19): by default the sim polls in
     *  preview mode (x-no-claim) so a scenario can inspect the same due
     *  window more than once. Pass { claim: true } to exercise the real
     *  dispatch path, where each instruction is claimed as it is handed
     *  out and therefore only ever returned once. */
    opts: { claim?: boolean } = {},
  ): Promise<Array<{ kind: string; key?: string; targetUser?: string; text?: string }>> {
    const res = await this.request.get(
      `/api/whatsapp/due-posts?groupId=${encodeURIComponent(this.groupId)}`,
      {
        headers: {
          ...HEADERS,
          "x-test-now": now.toISOString(),
          ...(opts.claim ? {} : { "x-no-claim": "1" }),
        },
      },
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

  /** The team sheet as the database has it, in `id: asc` order — the
   *  same order `load-state.ts` reads it in. */
  async teamSheet(matchId?: string): Promise<Array<{ key: string; team: string }>> {
    const rows = await this.db.all<{ userId: string; team: string }>(
      `SELECT "userId", team FROM "TeamAssignment" WHERE "matchId" = $1 ORDER BY id ASC`,
      [this.requireMatch(matchId)],
    );
    return rows.map((r) => ({ key: this.keyOf(r.userId), team: r.team }));
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

  /** Insert an ADDITIONAL match for this org's activity and return its id.
   *  Used by the rollover scenario (two upcoming matches at once). The
   *  kickoff is `daysFromNow` days out at 20:00 London (negative = past);
   *  attendanceDeadline is kickoff − 5h, mirroring createGroup. Optional
   *  initial attendance can be seeded by player key. */
  async addMatch(opts: {
    daysFromNow: number;
    status?: "UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED";
    attendance?: Array<{ key: string; status: AttStatus }>;
  }): Promise<string> {
    const id = `sim-match2-${nextMsgId()}`;
    const date = londonAt(opts.daysFromNow, 20, 0);
    await this.db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        id,
        this.activityId,
        date,
        this.maxPlayers,
        opts.status ?? "UPCOMING",
        new Date(date.getTime() - 5 * 60 * 60 * 1000),
      ],
    );
    let pos = 0;
    for (const a of opts.attendance ?? []) {
      await this.db.run(
        `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        [`sim-att2-${nextMsgId()}`, id, this.player(a.key).userId, a.status, ++pos],
      );
    }
    return id;
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
