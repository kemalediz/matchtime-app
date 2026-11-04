/**
 * EVERY DOOR HONOURS THE CLUB'S SWITCHES: THE WEBSITE (club summary, slice
 * B7; plan D8; decision K4, Kemal 2026-11-04).
 *
 * K4: when attendance is off a player cannot tap IN or OUT on the website,
 * as he cannot in WhatsApp; the match page says the club does not take
 * sign-ups through MatchTime. The same principle for player ratings: with
 * ratings off no rating DM goes out, so the match page has no rate button,
 * the rate page says so, and its actions (the ratings and the Man of the
 * Match vote cast with them) save nothing. Man of the Match off alone is
 * left as its settings card describes it: no winner posted, the votes still
 * count.
 *
 * The pure and scheduler half is `src/lib/__tests__/switches-every-door.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NOW, RATINGS, SUTTON, featuresFor, orgRow } from "@/lib/club-summary/__tests__/fixtures";
import type { ClubRows, OrgRow } from "@/lib/club-summary/derive";
import type { OrgFeatures } from "@/lib/org-features";
import { fakeWebDb, webWorld, type Call, type WebWorld } from "./fixtures/web-world";

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
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
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

import MatchDetailPage from "@/app/matches/[matchId]/page";
import { attendMatch, dropFromMatch } from "@/app/actions/attendance";
import { submitMoMVote, submitRatings } from "@/app/actions/ratings";
import { GET as matchGET } from "@/app/api/matches/[matchId]/route";

/** A shape with some switches changed, on the club's row and its switches alike. */
function variant(base: ClubRows, row: Partial<OrgRow>, f: Partial<OrgFeatures>): ClubRows {
  const org = orgRow({ ...base.org, ...row });
  return { ...base, org, features: featuresFor(org, { ...base.features, ...f }) };
}

function enter(rows: ClubRows, viewer: (w: WebWorld) => string): WebWorld {
  const w = webWorld(rows);
  calls.length = 0;
  state.db = fakeWebDb(w, calls);
  state.session = { user: { id: viewer(w) } };
  return w;
}

const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
const writes = () => calls.filter((c) => WRITES.test(c.method)).map((c) => `${c.model}.${c.method}`);

async function page(matchId: string): Promise<string> {
  return renderToStaticMarkup((await MatchDetailPage({ params: Promise.resolve({ matchId }), searchParams: Promise.resolve({}) })) as ReactElement);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("attendance off (K4): no IN or OUT on the website", () => {
  it("the match page shows no IN button, and says the club takes no sign-ups through MatchTime", async () => {
    const w = enter(RATINGS, (x) => x.viewers.player);
    const html = await page(w.matches[0].id as string);
    expect(html).not.toContain("I&#x27;m in!");
    expect(html).toContain('data-testid="attendance-off"');
    expect(html).toContain("Thursday Ratings doesn&#x27;t take sign-ups through MatchTime");
  });
  it("in Turkish too", async () => {
    const w = enter(variant(RATINGS, { language: "tr" }, { language: "tr" }), (x) => x.viewers.player);
    const html = await page(w.matches[0].id as string);
    expect(html).toContain("kayıtları MatchTime üzerinden almıyor");
  });
  it("attendance on (Sutton): the IN button, as before", async () => {
    const w = enter(SUTTON, (x) => x.viewers.player);
    const upcoming = w.matches.find((m) => m.status === "UPCOMING")!;
    const html = await page(upcoming.id as string);
    expect(html).toContain("I&#x27;m in!");
    expect(html).not.toContain('data-testid="attendance-off"');
  });
  it("attendMatch and dropFromMatch refuse with the same line and write nothing", async () => {
    const w = enter(RATINGS, (x) => x.viewers.player);
    const id = w.matches[0].id as string;
    await expect(attendMatch(id)).rejects.toThrow("Thursday Ratings doesn't take sign-ups through MatchTime");
    await expect(dropFromMatch(id)).rejects.toThrow("Thursday Ratings doesn't take sign-ups through MatchTime");
    expect(writes()).toEqual([]);
  });
});

/** Sutton's played match, as one of its players who played it. */
function played(rows: ClubRows) {
  const w = enter(rows, (x) => {
    const m = x.matches.find((mm) => mm.status === "COMPLETED")!;
    return (m.attendances as Array<{ userId: string; status: string }>).find((a) => a.status === "CONFIRMED")!.userId;
  });
  const m = w.matches.find((mm) => mm.status === "COMPLETED")!;
  const others = (m.attendances as Array<{ userId: string }>).map((a) => a.userId).filter((u) => u !== state.session!.user.id);
  // Inside the rating window: kickoff an hour ago.
  m.date = new Date(NOW.getTime() - 60 * 60 * 1000);
  return { id: m.id as string, other: others[0] };
}

describe("player ratings off: nothing to rate on the website", () => {
  const OFF = variant(SUTTON, { featurePlayerRating: false } as Partial<OrgRow>, { playerRating: false });
  it("the match page has no rate button", async () => {
    const { id } = played(OFF);
    expect(await page(id)).not.toContain(`/matches/${id}/rate`);
  });
  it("ratings on: the rate button, as before", async () => {
    const { id } = played(SUTTON);
    expect(await page(id)).toContain(`/matches/${id}/rate`);
  });
  it("the rate page's data says ratings are off, with no vote", async () => {
    const { id } = played(OFF);
    const body = await (await matchGET(new Request("http://x"), { params: Promise.resolve({ matchId: id }) })).json();
    expect(body).toMatchObject({ ratingsOff: true, momVote: false });
  });
  it("submitRatings refuses with one plain line and saves nothing", async () => {
    const { id, other } = played(OFF);
    await expect(submitRatings(id, { ratings: [{ playerId: other, score: 7 }] })).rejects.toThrow(
      "Sutton FC doesn't use player ratings in MatchTime, so there's nothing to rate here.",
    );
    expect(writes()).toEqual([]);
  });
});

describe("the Man of the Match vote follows the ratings, not its own switch", () => {
  it("ratings off: the vote saves nothing", async () => {
    const { id, other } = played(variant(SUTTON, { featurePlayerRating: false } as Partial<OrgRow>, { playerRating: false }));
    expect(await submitMoMVote(id, { playerId: other })).toEqual({ saved: false });
    expect(writes()).toEqual([]);
  });
  it("Man of the Match off alone: the vote is still taken (its settings card says the votes still count)", async () => {
    const { id, other } = played(variant(SUTTON, { featureMomVoting: false } as Partial<OrgRow>, { momVoting: false }));
    const body = await (await matchGET(new Request("http://x"), { params: Promise.resolve({ matchId: id }) })).json();
    expect(body).toMatchObject({ ratingsOff: false, momVote: true });
    await submitMoMVote(id, { playerId: other });
    expect(writes()).toContain("moMVote.upsert");
  });
});
