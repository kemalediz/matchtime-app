/**
 * A FAKE DATABASE FOR THE WEB PAGES' CHARACTERISATION (club summary, slice
 * A4, MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * The analyze path's fake world (slice A2, `src/lib/__tests__/fixtures/
 * analyze-world.ts`) for one club of the summary's fixtures, plus what the
 * web pages read that the bot paths do not:
 *   - compound unique keys (`matchId_userId`, `userId_orgId`,
 *     `userId_activityId`), answered from the rows by their fields;
 *   - every membership with its club (`include: { org: true }`), every user
 *     with `activityPositions`, the club row with its member count;
 *   - a viewer for every role: an organiser, a player, and the collector
 *     when the club has one.
 * Reads return full rows (a superset of any select or include); writes
 * succeed, are logged, and change nothing. Every call is logged, so the
 * same fake counts the reads one page load makes.
 */
import type { ClubRows } from "@/lib/club-summary/derive";
import { analyzeWorld, fakeAnalyzeDb, type AnalyzeWorld, type Call } from "@/lib/__tests__/fixtures/analyze-world";

type Row = Record<string, unknown>;

export interface WebWorld extends AnalyzeWorld {
  /** The club's organiser, an ordinary player and (when set) the collector. */
  viewers: { admin: string; player: string; collector: string | null };
}

const d = (iso: string) => new Date(iso);

export function webWorld(rows: ClubRows): WebWorld {
  const w = analyzeWorld(rows);
  const orgId = rows.org.id;
  const addMember = (id: string, name: string, role: string) => {
    if (w.users.some((u) => u.id === id)) {
      const m = w.memberships.find((x) => x.userId === id);
      if (m) m.role = role;
      return;
    }
    w.users.push({ id, name, phoneNumber: `+4477009${String(5000 + w.users.length)}`, isActive: true });
    w.memberships.push({
      id: `mem-${id}`,
      orgId,
      userId: id,
      role,
      leftAt: null,
      guestFromOrgId: null,
      guestMatchId: null,
      guestVia: null,
      provisionallyAddedAt: null,
      createdAt: d("2026-01-02T00:00:00Z"),
      user: { id, name, phoneNumber: null, isActive: true },
    });
  };
  // Every shape gets an organiser and a player of its own, so the pages
  // can be seen as each.
  const admin = w.memberships.find((m) => m.role === "OWNER" || m.role === "ADMIN")?.userId as string | undefined;
  const adminId = admin ?? `u-${orgId}-admin`;
  if (!admin) addMember(adminId, "Organiser", "OWNER");
  const playerId = `u-${orgId}-player`;
  addMember(playerId, "Player Viewer", "PLAYER");

  for (const u of w.users) {
    u.activityPositions = [];
    u.isSuperadmin = false;
    u.onboarded = true;
    u.email = `${u.id}@example.test`;
  }
  const userById = new Map(w.users.map((u) => [u.id, u]));
  for (const m of w.memberships) {
    m.guestVia = m.guestVia ?? null;
    m.org = w.org;
    m.user = { ...(userById.get(m.userId as string) ?? {}), ...(m.user as Row) };
  }
  w.org._count = { memberships: w.memberships.length };
  w.org.inviteCode = `invite-${orgId}`;
  w.org.featurePlayerPool = false;
  w.org.billingPlan = null;
  w.org.billingPricePence = null;
  // The match rows carry what the match pages read.
  for (const m of w.matches) {
    m.momVotes = [];
    for (const a of m.attendances as Row[]) a.user = { ...(userById.get(a.userId as string) ?? {}), ...(a.user as Row), activityPositions: [] };
    for (const t of m.teamAssignments as Row[]) t.user = { ...(userById.get(t.userId as string) ?? {}), ...(t.user as Row), activityPositions: [] };
    (m.activity as Row).ratingWindowHours = 48;
    (m.activity as Row).orgId = orgId;
    (m.activity as Row).org = w.org;
  }
  for (const a of w.extra.attendance) a.user = { ...(userById.get(a.userId as string) ?? {}), ...(a.user as Row), activityPositions: [] };
  return {
    ...w,
    viewers: { admin: adminId, player: playerId, collector: rows.org.paymentHolderId },
  };
}

/** A where with its compound unique keys spread into plain fields. */
function flatten(where: Row | undefined): Row | undefined {
  if (!where) return where;
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.includes("_") && v && typeof v === "object" && !(v instanceof Date)) Object.assign(out, v as Row);
    else out[k] = v;
  }
  return out;
}

/** The fake `db` of one web world. Every call is logged into `calls`. */
export function fakeWebDb(world: WebWorld, calls: Call[]) {
  const inner = fakeAnalyzeDb(world, []) as Record<string, Record<string, (args?: Row) => Promise<unknown>>>;
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
        if (!models.has(model)) {
          models.set(
            model,
            new Proxy(
              {},
              {
                get: (_t2, method: string) => async (args: Row = {}) => {
                  calls.push({ model, method, args });
                  if (method === "findUnique" || method === "findUniqueOrThrow") {
                    const flat = flatten(args.where as Row);
                    const compound = Object.keys((args.where as Row) ?? {}).some((k) => k.includes("_"));
                    return compound ? inner[model].findFirst({ ...args, where: flat }) : inner[model][method](args);
                  }
                  return inner[model][method](args);
                },
              },
            ),
          );
        }
        return models.get(model);
      },
    },
  );
  return db;
}

/** Reads, by the call log. */
export const readCount = (calls: Call[]) => calls.filter((c) => /^(find|count|aggregate|groupBy)/.test(c.method)).length;

export type { Call };
