/**
 * WHAT THE WEB PAGES RENDER AND DECIDE TODAY, PINNED (club summary, slice
 * A4, MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * Written FIRST, on the pages as they were before A4, and run green there:
 * A4 moves the pages' club facts (payments, the collector, squad mode, the
 * routine settings, the switches, the team names) onto the club summary and
 * must leave every value exactly as it was, so this snapshot must not change.
 *
 * For each club shape of the summary's fixtures, plus three variants that
 * switch on what the five leave off (a collector who is not an organiser, a
 * rolling squad with organiser picks and organiser MoM and team names;
 * collection with direct-pay instructions; a monthly club's instructions),
 * and a Turkish-speaking Sutton, every page group is loaded as each viewer
 * (the organiser, a player, the collector):
 *   - pay:      /pay/[matchId], /collect/[matchId], `requireMatchCollectorOrAdmin`;
 *   - month:    /month, /month/collect, /admin/months;
 *   - match:    /matches/[matchId];
 *   - settings: GET /api/org/settings, `getTeamsReady`.
 * Recorded per load: the HTML (or JSON), or the redirect or 404 it ends in.
 * The database is a fake world (fixtures/web-world.ts) answering every read
 * from the same rows before and after A4; the clock is fixed.
 *
 * The same fake counts the reads one page load makes; the last test prints
 * them (the read count before and after A4), and pins nothing.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { FNF, MUTED, NOW, RATINGS, SUTTON, VETS, featuresFor, orgRow } from "@/lib/club-summary/__tests__/fixtures";
import type { ClubRows, OrgRow } from "@/lib/club-summary/derive";
import { fakeWebDb, readCount, webWorld, type Call, type WebWorld } from "./fixtures/web-world";

const state: { db: unknown; session: { user: { id: string } } | null } = { db: null, session: null };
const calls: Call[] = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => state.session,
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: {},
}));

class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  permanentRedirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new NotFound("notFound");
  },
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (f: unknown) => f }));

import PayPage from "@/app/pay/[matchId]/page";
import CollectPage from "@/app/collect/[matchId]/page";
import MonthPage from "@/app/month/page";
import MonthCollectPage from "@/app/month/collect/page";
import MonthsPage from "@/app/admin/months/page";
import MatchDetailPage from "@/app/matches/[matchId]/page";
import { GET as settingsGET } from "@/app/api/org/settings/route";
import { getTeamsReady } from "@/app/actions/teams-ready";
import { requireMatchCollectorOrAdmin } from "@/app/actions/payments";

// ── The shapes ─────────────────────────────────────────────────────────

const variant = (base: ClubRows, over: Partial<OrgRow>): ClubRows => {
  const org = orgRow({ ...base.org, ...over });
  return { ...base, org, features: featuresFor(org), collectorName: over.paymentHolderId === undefined ? base.collectorName : over.paymentHolderId ? "Collector" : null };
};

const WEB_SHAPES: Record<string, ClubRows> = {
  sutton: SUTTON,
  "sutton-tr": variant(SUTTON, { language: "tr" }),
  // A collector who is not an organiser, a rolling squad, organiser picks,
  // organiser MoM, the club's own team names, Teams ready set, no card.
  "sutton-zed": variant(SUTTON, {
    paymentHolderId: "u-zed",
    rollingSquadEnabled: true,
    benchPickMode: "organiser",
    momChosenBy: "organisers",
    teamLabels: ["Bibs", "Shirts"],
    teamsReadyTime: "11:30",
    payMethodCard: false,
  }),
  fnf: FNF,
  // Collection on, no Stripe: paying the collector directly, with words.
  "fnf-collects": variant(FNF, { paymentCollectionEnabled: true, paymentHolderId: "u-fnf-org", paymentInstructions: "  Monzo 12-34-56  " }),
  vets: VETS,
  "vets-instr": variant(VETS, { paymentInstructions: "Pay Davide on the night", paymentTrackingEnabled: true }),
  ratings: RATINGS,
  muted: MUTED,
};

/** The world of one shape, as the pages see it: the first match has a fee
 *  (7 when the fixture has none), its second attendee is paying directly. */
function worldOf(name: string): WebWorld {
  const w = webWorld(WEB_SHAPES[name]);
  const first = w.matches[0];
  first.feePerPlayer = first.feePerPlayer ?? 7;
  const second = (first.attendances as Array<Record<string, unknown>>)[1];
  if (second) {
    for (const a of [second, ...w.extra.attendance.filter((x) => x.id === second.id)]) {
      a.directPendingAt = new Date("2026-11-03T10:00:00Z");
      a.paymentMethod = "direct";
    }
  }
  return w;
}

// ── Loading a page ─────────────────────────────────────────────────────

function useWorld(name: string, viewer: string | null): WebWorld {
  const w = worldOf(name);
  calls.length = 0;
  state.db = fakeWebDb(w, calls);
  state.session = viewer ? { user: { id: viewer } } : null;
  return w;
}

const tidy = (html: string) => html.replace(/></g, ">\n<");

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const out = await run();
    if (out instanceof Response) return `status ${out.status}\n${JSON.stringify(await out.json(), null, 1)}`;
    if (out && typeof out === "object" && "type" in (out as object)) return tidy(renderToStaticMarkup(out as ReactElement));
    return JSON.stringify(out, null, 1);
  } catch (err) {
    if (err instanceof Redirect) return `redirect ${err.url}`;
    if (err instanceof NotFound) return "notFound";
    return `error ${(err as Error).message}`;
  }
}

const params = <T,>(v: T) => Promise.resolve(v);



function viewersOf(w: WebWorld): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["admin", w.viewers.admin],
    ["player", w.viewers.player],
  ];
  if (w.viewers.collector && w.viewers.collector !== w.viewers.admin) out.push(["collector", w.viewers.collector]);
  return out;
}

/** Every load of every page group for one shape. */
function loadsOf(name: string): Array<{ group: string; label: string; viewer: string | null; run: () => Promise<unknown> }> {
  const w = worldOf(name);
  const first = w.matches[0];
  const last = w.matches[w.matches.length - 1];
  const att = (first.attendances as Array<Record<string, unknown>>).map((a) => a.userId as string);
  const out: Array<{ group: string; label: string; viewer: string | null; run: () => Promise<unknown> }> = [];
  const pay = (matchId: string, paid?: string) => () => PayPage({ params: params({ matchId }), searchParams: params(paid ? { paid } : {}) });
  if (att[0]) out.push({ group: "pay", label: "pay first match, first attendee", viewer: att[0], run: pay(first.id as string) });
  if (att[1]) out.push({ group: "pay", label: "pay first match, paying directly", viewer: att[1], run: pay(first.id as string) });
  out.push({ group: "pay", label: "pay first match, not in the squad", viewer: w.viewers.player, run: pay(first.id as string) });
  out.push({ group: "pay", label: "pay last match, not in the squad", viewer: w.viewers.player, run: pay(last.id as string) });
  out.push({ group: "pay", label: "pay, back from checkout", viewer: w.viewers.player, run: pay(first.id as string, "1") });
  for (const [role, id] of viewersOf(w)) {
    out.push({ group: "pay", label: `collect first match as ${role}`, viewer: id, run: () => CollectPage({ params: params({ matchId: first.id as string }) }) });
    out.push({ group: "pay", label: `requireMatchCollectorOrAdmin as ${role}`, viewer: id, run: () => requireMatchCollectorOrAdmin(id, first.id as string) });
    out.push({ group: "month", label: `month as ${role}`, viewer: id, run: () => MonthPage({ searchParams: params({}) }) });
    out.push({ group: "month", label: `month collect as ${role}`, viewer: id, run: () => MonthCollectPage({ searchParams: params({}) }) });
    out.push({ group: "month", label: `admin months as ${role}`, viewer: id, run: () => MonthsPage({ searchParams: params({}) }) });
    for (const m of [first, last]) {
      out.push({ group: "match", label: `match ${m.id} as ${role}`, viewer: id, run: () => MatchDetailPage({ params: params({ matchId: m.id as string }), searchParams: params({}) }) });
    }
    out.push({ group: "settings", label: `GET /api/org/settings as ${role}`, viewer: id, run: () => settingsGET() });
    out.push({ group: "settings", label: `getTeamsReady as ${role}`, viewer: id, run: () => getTeamsReady(w.org.id as string) });
  }
  out.push({ group: "pay", label: "pay signed out", viewer: null, run: pay(first.id as string) });
  return out;
}

async function runLoad(name: string, load: { viewer: string | null; run: () => Promise<unknown> }) {
  useWorld(name, load.viewer);
  const text = await outcome(load.run);
  return { text, reads: readCount(calls) };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("the web pages, per club shape (characterisation)", () => {
  for (const group of ["pay", "month", "match", "settings"]) {
    describe(group, () => {
      it.each(Object.keys(WEB_SHAPES))("%s", async (name) => {
        const out: Record<string, string> = {};
        for (const load of loadsOf(name).filter((l) => l.group === group)) out[load.label] = (await runLoad(name, load)).text;
        expect(out).toMatchSnapshot();
      });
    });
  }
});

describe("reads per page load (reported, not pinned here)", () => {
  it("prints them", async () => {
    const report: Record<string, Record<string, number>> = {};
    for (const name of ["sutton", "fnf", "vets", "ratings", "muted"]) {
      report[name] = {};
      for (const load of loadsOf(name).filter((l) => / as admin$|first attendee|last match/.test(l.label))) report[name][load.label] = (await runLoad(name, load)).reads;
    }
    // MT_WEB_READS_OUT=<file> writes them out (the console is quiet in unit runs).
    if (process.env.MT_WEB_READS_OUT) writeFileSync(process.env.MT_WEB_READS_OUT, JSON.stringify(report, null, 1));
    expect(Object.keys(report)).toHaveLength(5);
  });
});
