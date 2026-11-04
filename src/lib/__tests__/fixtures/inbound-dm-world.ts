/**
 * A FAKE DATABASE FOR THE INBOUND DM CHARACTERISATION (Cloud API plan C3,
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.3).
 *
 * A copy, for main, of the club summary branch's fake worlds
 * (`refactor/club-summary`: `src/lib/__tests__/fixtures/scheduler-world.ts`,
 * `analyze-world.ts` and `hq-dm-world.ts`, slices A1 to A3), merged into one
 * file and read from `inbound-dm-clubs.ts`. One club's world: each model
 * returns full rows (a superset of any select) filtered by the parts of the
 * `where` the readers use; every table the fake does not hold answers
 * empty; writes succeed, are logged and change nothing, so every request
 * sees the same world before and after the move of the DM pipeline into
 * `src/lib/inbound-dm.ts`.
 *
 * Every call is logged (model, method, args).
 */
import type { ClubRows, MemberRow } from "./inbound-dm-clubs";

export type Call = { model: string; method: string; args: Record<string, unknown> };

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

const d = (iso: string) => new Date(iso);

/** The feature columns `getOrgFeatures` selects, from the fixture's switches. */
function featureColumns(rows: ClubRows): Row {
  const f = rows.features;
  return {
    featureAttendance: f.attendance,
    featureBench: f.bench,
    featureTeamBalancing: f.teamBalancing,
    featureMomVoting: f.momVoting,
    featurePlayerRating: f.playerRating,
    featureReminders: f.reminders,
    featureStatsQa: f.statsQa,
    featureSquadFromList: f.squadFromList,
    featureBadgeAnnouncements: f.badgeAnnouncements,
    featureGearReminder: f.gearReminder ?? true,
    featurePlayerPool: false,
  };
}

export interface SchedulerWorld {
  org: Row;
  activities: Row[];
  sports: Row[];
  matches: Row[];
  months: Row[];
  sent: Array<{ key: string; kind: string; createdAt: Date; matchId?: string | null }>;
  memberships: Row[];
  users: Row[];
}

/** The world of one fixture club: its org row (every column the scheduler
 *  reads), activities with sports, matches with named attendances, months
 *  with members, memberships. */
export function schedulerWorld(rows: ClubRows): SchedulerWorld {
  const org: Row = {
    ...rows.org,
    ...featureColumns(rows),
    slug: rows.org.id,
    approvedAt: null,
    teamLabels: null,
    partnerAskMode: "off",
    billingPlan: null,
    billingPricePence: null,
    createdAt: d("2026-01-01T00:00:00Z"),
  };
  const sports = rows.activities.map((a) => ({ id: `sport-${a.id}`, name: a.sport.name, playersPerTeam: a.sport.playersPerTeam, teamLabels: null }));
  const activities = rows.activities.map((a, i) => ({
    ...a,
    orgId: rows.org.id,
    sportId: sports[i].id,
    sport: sports[i],
    deadlineHours: 5,
    ratingWindowHours: null,
    teamLabels: null,
  }));
  const actOf = (id: string) => activities.find((a) => a.id === id)!;
  const orgInclude = { ...org };

  const users: Row[] = [];
  const memberships: Row[] = [];
  const addUser = (id: string, name: string | null, phone: string | null, role = "PLAYER") => {
    if (users.some((u) => u.id === id)) return;
    users.push({ id, name, phoneNumber: phone, isActive: true });
    memberships.push({
      id: `mem-${id}`,
      orgId: rows.org.id,
      userId: id,
      role,
      leftAt: null,
      guestFromOrgId: null,
      guestMatchId: null,
      provisionallyAddedAt: null,
      createdAt: d("2026-01-01T00:00:00Z"),
      subTentativeDm: true,
      subMatchInviteDm: true,
      subBenchOfferDm: true,
      subRatingDm: true,
      user: { id, name, phoneNumber: phone, isActive: true },
    });
  };
  for (const m of rows.members?.rows ?? []) addUser(m.user.id, m.user.name, m.user.phoneNumber, String(m.role));
  if (rows.org.paymentHolderId) addUser(rows.org.paymentHolderId, rows.collectorName, "+447700900999", "OWNER");

  // A monthly club's regulars are the month's members and the seeded rows.
  const regularIds = (n: number) => Array.from({ length: n }, (_, i) => `u-${rows.org.id}-r${i + 1}`);
  const months = rows.months.map((mo) => {
    const a = actOf(mo.activityId);
    const regulars = mo.members.filter((x) => x.kind !== "payg");
    const ids = regularIds(regulars.length);
    ids.forEach((id, i) => addUser(id, `Regular ${i + 1}`, `+4477009${String(1000 + i)}`));
    return {
      ...mo,
      orgId: rows.org.id,
      gamesPlayedBeforeStart: 0,
      sharePerGamePence: null,
      concessionPerGamePence: null,
      venueCostPence: null,
      payByAt: null,
      summarySentAt: null,
      activity: { ...a, orgId: rows.org.id },
      org: { language: rows.org.language },
      members: mo.members.map((x, i) => ({
        ...x,
        userId: x.kind === "payg" ? `u-${rows.org.id}-payg${i}` : ids[i],
        slot: x.kind === "payg" ? null : i + 1,
        tier: null,
        note: null,
        absentMatchIds: [],
        paygMatchIds: [],
        gamesCovered: null,
        gamesCommitted: null,
        joinedAt: d("2026-10-20T10:00:00Z"),
        source: "seed",
        createdAt: d("2026-10-20T10:00:00Z"),
        leftAt: null,
        user: { name: x.kind === "payg" ? "Payg" : `Regular ${i + 1}` },
      })),
    };
  });

  const matches = rows.matches.map((m) => {
    const a = actOf(m.activityId);
    const monthly = rows.org.squadMode === "monthly" && m.rollingSeededAt != null;
    let n = 0;
    const attendances = m.attendances.map((x, i) => {
      const uid = monthly && x.status === "CONFIRMED" ? regularIds(13)[n++] ?? `u-${m.id}-${i}` : `u-${m.id}-${i}`;
      const name = monthly && uid.includes("-r") ? `Regular ${uid.split("-r").pop()}` : `Player ${i + 1}`;
      addUser(uid, name, `+44770${String(100000 + users.length)}`);
      return {
        id: `att-${m.id}-${i}`,
        matchId: m.id,
        userId: uid,
        status: x.status,
        position: i + 1,
        paidAt: null,
        directPendingAt: null,
        feeWaivedAt: null,
        paymentMethod: monthly ? "monthly" : null,
        team: null,
        votes: [],
        createdAt: d("2026-10-30T10:00:00Z"),
        user: { id: uid, name, phoneNumber: `+44770${String(100000 + users.length)}` },
      };
    });
    const teamAssignments = attendances.slice(0, m._count.teamAssignments).map((x, i) => ({
      userId: x.userId,
      team: i % 2 === 0 ? "RED" : "YELLOW",
      user: { id: x.userId, name: x.user.name },
    }));
    return {
      ...m,
      isHistorical: false,
      postMatchEndFlow: true,
      rollingSeededFromMatchId: null,
      redScore: null,
      yellowScore: null,
      teamLabels: null,
      createdAt: d("2026-10-01T10:00:00Z"),
      attendances,
      teamAssignments,
      benchConfirmations: [],
      benchSlotOffers: [],
      paymentCredits: [],
      activity: { ...a, org: orgInclude },
    };
  });

  return { org, activities, sports, matches, months, sent: [], memberships, users };
}

// ── The where-matcher (only what the scheduler's reads use) ────────────

function cmp(v: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== "object") return v === cond;
  const c = cond as Record<string, unknown>;
  if ("in" in c && !(c.in as unknown[]).some((x) => (x instanceof Date && v instanceof Date ? x.getTime() === v.getTime() : x === v))) return false;
  if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
  if ("not" in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
  const t = v instanceof Date ? v.getTime() : (v as number);
  const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
  if ("gte" in c && !(v != null && t >= n(c.gte))) return false;
  if ("gt" in c && !(v != null && t > n(c.gt))) return false;
  if ("lte" in c && !(v != null && t <= n(c.lte))) return false;
  if ("lt" in c && !(v != null && t < n(c.lt))) return false;
  if ("startsWith" in c && !(typeof v === "string" && v.startsWith(c.startsWith as string))) return false;
  if ("contains" in c && !(typeof v === "string" && v.includes(c.contains as string))) return false;
  if ("equals" in c && v !== c.equals) return false;
  return true;
}

/** Fields of a where that refer to the club or its relations: always true
 *  in a one-club world. */
const RELATION_KEYS = new Set(["activity", "match", "org", "user", "members", "attendances", "orgId"]);

function matches(row: Row, where: Where): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "AND") {
      const list = Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
      if (!list.every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "NOT") continue;
    if (RELATION_KEYS.has(k) && (k !== "orgId" || typeof cond !== "string")) {
      if (k === "orgId" && typeof cond === "string" && row.orgId !== undefined && row.orgId !== cond) return false;
      continue;
    }
    if (!(k in row)) continue;
    if (!cmp(row[k], cond)) return false;
  }
  return true;
}

function order(rows: Row[], orderBy: unknown): Row[] {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const out = [...rows];
  for (const o of [...list].reverse()) {
    const [field, dir] = Object.entries(o as Record<string, unknown>)[0] ?? [];
    if (!field || typeof dir !== "string") continue;
    out.sort((a, b) => {
      const x = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as number | string);
      const y = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as number | string);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return dir === "desc" ? -c : c;
    });
  }
  return out;
}

function many(rows: Row[], args: Record<string, unknown> = {}): Row[] {
  let out = order(
    rows.filter((r) => matches(r, args.where as Where)),
    args.orderBy,
  );
  if (typeof args.take === "number") out = out.slice(0, args.take);
  return out;
}

/** The fake `db`: logs every call into `calls`. `extra`: more tables, by
 *  model name (the analyze path's characterisation reads more of them). */
export function fakeSchedulerDb(
  world: SchedulerWorld,
  calls: Call[],
  extra: Record<string, Row[]> = {},
  /** "per-model": a created row's id counts that model's creates, so it
   *  does not move when the number of reads before it does. */
  createIds: "call-count" | "per-model" = "call-count",
) {
  const created = new Map<string, number>();
  const tables: Record<string, Row[]> = {
    ...extra,
    organisation: [world.org],
    activity: world.activities,
    sport: world.sports,
    match: world.matches,
    squadMonth: world.months,
    sentNotification: world.sent as unknown as Row[],
    membership: world.memberships,
    user: world.users,
  };
  const handler = (model: string, method: string) => async (args: Record<string, unknown> = {}) => {
    calls.push({ model, method, args });
    const rows = tables[model];
    switch (method) {
      case "findMany":
        return rows ? many(rows, args) : [];
      case "findFirst":
      case "findFirstOrThrow":
        return rows ? (many(rows, { ...args, take: 1 })[0] ?? null) : null;
      case "findUnique":
      case "findUniqueOrThrow": {
        if (!rows) return null;
        const where = (args.where ?? {}) as Row;
        // Compound unique keys (matchId_userId and the like) are not
        // modelled: nothing unique is found.
        if (Object.values(where).some((v) => v && typeof v === "object" && !(v instanceof Date))) return null;
        return many(rows, args)[0] ?? null;
      }
      case "count":
        return rows ? many(rows, { where: args.where }).length : 0;
      case "groupBy":
        return [];
      case "aggregate":
        return { _sum: {}, _count: {}, _max: {}, _min: {} };
      case "updateMany":
      case "deleteMany":
      case "createMany":
        return { count: 0 };
      case "create": {
        const n = createIds === "per-model" ? (created.get(model) ?? 0) + 1 : calls.length;
        created.set(model, n);
        return { id: `new-${model}-${n}`, ...((args.data as Row) ?? {}) };
      }
      default:
        return {};
    }
  };
  const models = new Map<string, unknown>();
  const db: unknown = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "then") return undefined;
        if (model === "$transaction") {
          return async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(db));
        }
        if (model.startsWith("$")) return async () => [];
        if (!models.has(model)) models.set(model, new Proxy({}, { get: (_t2, method: string) => handler(model, method) }));
        return models.get(model);
      },
    },
  );
  return db;
}

// ── The analyze path's tables (slice A2) ───────────────────────────────

export interface AnalyzeWorld extends SchedulerWorld {
  extra: Record<string, Row[]>;
}

export function analyzeWorld(rows: ClubRows): AnalyzeWorld {
  const w = schedulerWorld(rows);
  const attendance = w.matches.flatMap((m) => (m.attendances as Row[]).map((a) => ({ ...a })));
  const teamAssignment = w.matches.flatMap((m) =>
    (m.teamAssignments as Row[]).map((t, i) => ({ id: `ta-${m.id}-${String(i).padStart(2, "0")}`, matchId: m.id, userId: t.userId, team: t.team, user: t.user })),
  );
  const userAlias = Object.entries(rows.members?.aliases ?? {}).flatMap(([userId, list]) =>
    list.map((alias, i) => ({ id: `al-${userId}-${i}`, orgId: rows.org.id, userId, alias: alias.toLowerCase(), source: "manual", createdAt: new Date("2026-01-01T00:00:00Z") })),
  );
  // Every match carries the columns the squad state reads.
  for (const m of w.matches) {
    m.teamLabels = [];
    m.activity = { ...(m.activity as Row), sport: { ...((m.activity as Row).sport as Row), teamLabels: [] } };
  }
  w.org.teamLabels = [];
  for (const s of w.sports) s.teamLabels = [];
  return { ...w, extra: { attendance, teamAssignment, userAlias } };
}

export function fakeAnalyzeDb(world: AnalyzeWorld, calls: Call[]) {
  return fakeSchedulerDb(world, calls, world.extra, "per-model");
}

// ── The admin group's and the DMs' needs (slice A3) ────────────────────

/** A club's rows with its admin group linked and every member given a
 *  real number: `+4477009003NN`, NN by roster position. */
export function withHq(rows: ClubRows, opts: { linkHq?: boolean } = {}): ClubRows {
  const members = rows.members
    ? {
        ...rows.members,
        rows: rows.members.rows.map(
          (m, i): MemberRow => ({ ...m, user: { ...m.user, phoneNumber: `+4477009003${String(i + 10)}` } }),
        ),
      }
    : null;
  const linkHq = opts.linkHq ?? true;
  return {
    ...rows,
    org: linkHq
      ? { ...rows.org, adminGroupId: rows.org.adminGroupId ?? `hq-${rows.org.id}@g.us`, adminChannelMode: "admin-group" }
      : rows.org,
    members,
  };
}

/** The phone of a member of `withHq` rows, by user id. */
export function phoneOf(rows: ClubRows, userId: string): string {
  const m = rows.members?.rows.find((r) => r.user.id === userId);
  if (!m?.user.phoneNumber) throw new Error(`no member ${userId} with a phone in ${rows.org.id}`);
  return m.user.phoneNumber;
}

export type HqDmWorld = AnalyzeWorld;

export function hqDmWorld(rows: ClubRows): HqDmWorld {
  const w = analyzeWorld(rows);
  // The admin group's own columns the HQ door reads off the club's row.
  w.org.featurePlayerPool = false;
  // The relations the DM route and the HQ door select through: a user's
  // memberships, a membership's club.
  for (const m of w.memberships) m.org = w.org;
  for (const u of w.users) u.memberships = w.memberships.filter((m) => m.userId === u.id).map((m) => ({ orgId: m.orgId, role: m.role }));
  // The team generator reads each player's positions through his user.
  const rowsWithUser = [...w.matches.flatMap((m) => m.attendances as Array<Record<string, unknown>>), ...(w.extra.attendance ?? [])];
  for (const a of rowsWithUser) a.user = { ...(a.user as Record<string, unknown>), activityPositions: [] };
  // The DM question's season stats read each played match's ratings.
  for (const m of w.matches) Object.assign(m, { ratings: [], momVotes: [] });
  return w;
}

/** The fake `db`, with the daily AI allowance's raw SQL answered as a club
 *  under its cap (one row, nothing spent): the DM classifiers' raw calls
 *  reserve from it before they ask (`ai-budget.ts`), and an empty answer
 *  reads as the cap reached. */
export function fakeHqDmDb(world: HqDmWorld, calls: Call[]) {
  const inner = fakeAnalyzeDb(world, calls) as Record<string, unknown>;
  return new Proxy(inner, {
    get(target, key: string) {
      if (key === "$queryRaw") return async () => [{ ok: 1, costUsd: 0, reservedUsd: 0 }];
      return target[key];
    },
  });
}

