/**
 * The scheduler does not post a squad the group has just been shown
 * (2026-10-06, Sutton FC). Driven through the real `computeDuePosts`
 * with Prisma mocked (the proxy pattern of rolling-squad-scheduler.test.ts)
 * and the composer mocked: NO model is called here.
 *
 * The incident, Tue 6 Oct 2026, match day:
 *   07:28  an admin: "@David is out ... Can we have more players please"
 *          MatchTime: the squad, 13/14, need 1 more, and
 *          "On it, DM'd 8 recent players".
 *   08:00  the match-day morning chase: the same thirteen names again.
 *
 * What is pinned:
 *   1. the same squad shown inside 3 hours: scheduled posts go out
 *      without the roster block and keep their other lines;
 *   2. a recruit ack for the same need inside 3 hours: the morning chase
 *      is skipped, and comes back when the need changes;
 *   3. a post that does carry the roster says so (`rosterShown`), so the
 *      next one can stay quiet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method),
          },
        ),
    },
  ),
}));

const features = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "first-come",
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));

const composeChaseText = vi.fn<(...a: unknown[]) => Promise<string | null>>();
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: (...a: unknown[]) => composeChaseText(...a),
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import {
  RECRUIT_ACK_KIND,
  ROSTER_SHOWN_KIND,
  recruitAckKey,
  rosterShownKey,
  squadFingerprint,
} from "@/lib/roster-shown";

const GROUP = "group-sutton@g.us";
const ORG = { id: "org-sutton", whatsappGroupId: GROUP, whatsappBotEnabled: true };
const MATCH_ID = "m-tue-6-oct";

/** Tue 6 Oct 2026, 21:30 London (20:30 UTC, BST). */
const KICKOFF = new Date("2026-10-06T20:30:00.000Z");
/** 07:28 London: the admin's message and MatchTime's reply. */
const REPLY_AT = new Date("2026-10-06T06:28:00.000Z");
/** 08:00 London: the match-day morning chase. */
const TUE_8AM = new Date("2026-10-06T07:00:17.000Z");
/** Mon 5 Oct, 17:05 London: the daily post, the day before. */
const MON_5PM = new Date("2026-10-05T16:05:00.000Z");
/** Tue 17:05 London: the daily post on match day. */
const TUE_5PM = new Date("2026-10-06T16:05:00.000Z");
/** Tue 18:00 London: 3.5h before kickoff. */
const TUE_6PM = new Date("2026-10-06T17:00:00.000Z");
/** Tue 20:00 London: 1.5h before kickoff. */
const TUE_8PM = new Date("2026-10-06T19:00:00.000Z");

const NAMES = Array.from({ length: 13 }, (_, i) => `Player ${i + 1}`);

function player(name: string, i: number, status = "CONFIRMED") {
  return {
    id: `att-${i}`,
    userId: `u${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u${i}`, name, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

function match(over: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "tue-7",
    // Sutton FC runs no sign-up deadline: it is the kickoff.
    attendanceDeadline: KICKOFF,
    attendances: NAMES.map((n, i) => player(n, i)),
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: [] as unknown[],
    paymentCredits: [] as unknown[],
    activity: {
      id: "tue-7",
      orgId: ORG.id,
      name: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      dayOfWeek: 2,
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: "en" },
    },
    ...over,
  };
}

type Marker = { key: string; kind: string; createdAt: Date };

function fingerprintOf(m: ReturnType<typeof match>): string {
  const atts = m.attendances as Array<{ userId: string; status: string }>;
  return squadFingerprint({
    confirmedUserIds: atts.filter((a) => a.status === "CONFIRMED").map((a) => a.userId),
    benchUserIds: atts.filter((a) => a.status === "BENCH").map((a) => a.userId),
    maxPlayers: m.maxPlayers as number,
  });
}

const rosterMarker = (m: ReturnType<typeof match>, at: Date): Marker => ({
  key: rosterShownKey(m.id, fingerprintOf(m), at),
  kind: ROSTER_SHOWN_KIND,
  createdAt: at,
});
const recruitMarker = (need: number, at: Date): Marker => ({
  key: recruitAckKey(MATCH_ID, need, at),
  kind: RECRUIT_ACK_KIND,
  createdAt: at,
});

function setWorld(m: ReturnType<typeof match>, markers: Marker[] = []) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = { findMany: async () => [m] };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const kind = (args as { where?: { kind?: unknown } }).where?.kind;
      // The sent-keys read has no `kind`.
      if (!kind) return markers.map(({ key }) => ({ key }));
      // The quiet-marker read asks for the two marker kinds.
      const wanted = (kind as { in?: string[] }).in;
      if (Array.isArray(wanted) && wanted.includes(ROSTER_SHOWN_KIND)) return markers;
      return [];
    },
  };
  // The one-time intro is not what these tests are about.
  overrides.activity = { count: async () => 0 };
}

type Post = { kind: string; key: string; text: string; rosterShown?: { fingerprint: string } };

async function posts(now: Date): Promise<Post[]> {
  const res = await computeDuePosts(GROUP, now);
  return (res?.instructions ?? []) as unknown as Post[];
}
const find = (out: Post[], part: string) => out.find((i) => i.key.includes(part));

const ROSTER = [...NAMES.map((n, i) => `${i + 1}. ${n}`), "14. 🥁"].join("\n");
const LEAD =
  "☀️ Squad update — 1 more and Tuesday 7-a-side is full. Kicking off 21:30 at Goals North Cheam. Who's in?\n\n" +
  "If we don't find 1 more, we could switch to 5-a-side (10 players): Player 11 + Player 12 + Player 13 go on the bench. Admins can rebook and flip it in the portal.";
/** What the composer writes: the lead, then the roster it is told to end on. */
const MODEL_TEXT = `${LEAD}\n\n*Playing tonight:*\n${ROSTER}`;

beforeEach(() => {
  composeChaseText.mockReset();
  composeChaseText.mockResolvedValue(MODEL_TEXT);
});

describe("the match-day morning chase after a roster was just posted", () => {
  it("with nothing posted recently it carries the roster, and says so", async () => {
    const m = match();
    setWorld(m);
    const chase = find(await posts(TUE_8AM), ":chase-match-day-morning:");
    expect(chase?.text).toBe(MODEL_TEXT);
    expect(chase?.rosterShown).toEqual({ fingerprint: fingerprintOf(m) });
  });

  it("THE INCIDENT, roster only: the same squad 32 minutes ago, so no roster block", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, REPLY_AT)]);
    const chase = find(await posts(TUE_8AM), ":chase-match-day-morning:");
    expect(chase, "the chase still goes out").toBeDefined();
    expect(chase!.text).toBe(LEAD);
    expect(chase!.text).not.toMatch(/^\s*\d+\.\s/m);
    expect(chase!.text).not.toContain("Playing tonight");
    // Its useful lines: the need, the kickoff, the 5-a-side fallback.
    expect(chase!.text).toContain("1 more");
    expect(chase!.text).toContain("21:30");
    expect(chase!.text).toContain("5-a-side");
    // It showed no roster, so it leaves no marker.
    expect(chase!.rosterShown).toBeUndefined();
  });

  it("a roster for a DIFFERENT squad does not count: someone dropped since", async () => {
    const before = match({ attendances: [...NAMES, "David"].map((n, i) => player(n, i)) });
    const m = match();
    setWorld(m, [rosterMarker(before, REPLY_AT)]);
    expect(find(await posts(TUE_8AM), ":chase-match-day-morning:")?.text).toBe(MODEL_TEXT);
  });

  it("a roster posted more than 3 hours ago does not count", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, new Date(TUE_8AM.getTime() - 3 * 60 * 60 * 1000 - 60_000))]);
    expect(find(await posts(TUE_8AM), ":chase-match-day-morning:")?.text).toBe(MODEL_TEXT);
  });
});

describe("the match-day morning chase after a recruit ack", () => {
  it("THE INCIDENT: 'On it, DM'd 8' for need 1 at 07:28, so no chase at 08:00", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, REPLY_AT), recruitMarker(1, REPLY_AT)]);
    expect(find(await posts(TUE_8AM), ":chase-match-day-morning:")).toBeUndefined();
    // And the model was not asked for a post nobody will see.
    expect(composeChaseText).not.toHaveBeenCalled();
  });

  it("it comes back later in the window once the need has changed", async () => {
    // Another player dropped at 08:20: need is 2, the ack was for 1.
    const m = match({ attendances: NAMES.slice(0, 12).map((n, i) => player(n, i)) });
    setWorld(m, [recruitMarker(1, REPLY_AT)]);
    const chase = find(await posts(new Date("2026-10-06T07:25:00.000Z")), ":chase-match-day-morning:");
    expect(chase?.text).toBe(MODEL_TEXT);
  });

  it("a recruit ack more than 3 hours old does not hold it back", async () => {
    const m = match();
    setWorld(m, [recruitMarker(1, new Date(TUE_8AM.getTime() - 3 * 60 * 60 * 1000 - 60_000))]);
    expect(find(await posts(TUE_8AM), ":chase-match-day-morning:")).toBeDefined();
  });

  it("the recruit ack holds back the morning chase only, never the later ones", async () => {
    const m = match();
    setWorld(m, [recruitMarker(1, new Date(TUE_6PM.getTime() - 30 * 60_000))]);
    expect(find(await posts(TUE_6PM), ":chase-pre-kickoff")).toBeDefined();
  });
});

describe("every other scheduled post that carries the roster", () => {
  it("17:00, short squad, composed: no roster when the same squad was just shown", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, new Date(MON_5PM.getTime() - 60 * 60_000))]);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toBe(LEAD);
    expect(post?.rosterShown).toBeUndefined();
  });

  it("17:00, short squad, composed: the roster when nothing was shown, with a marker", async () => {
    const m = match();
    setWorld(m);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toBe(MODEL_TEXT);
    expect(post?.rosterShown).toEqual({ fingerprint: fingerprintOf(m) });
  });

  it("17:00, short squad, the fixed text (composer down): the lead alone", async () => {
    composeChaseText.mockResolvedValue(null);
    const m = match();
    setWorld(m, [rosterMarker(m, new Date(MON_5PM.getTime() - 60 * 60_000))]);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toBe("🗓 *Tuesday 7-a-side* — need *1 more*.");
    expect(post?.rosterShown).toBeUndefined();
  });

  it("17:00, short squad, the fixed text with nothing shown: the roster, with a marker", async () => {
    composeChaseText.mockResolvedValue(null);
    const m = match();
    setWorld(m);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toContain("*Confirmed (13/14):*\n1. Player 1");
    expect(post?.rosterShown).toEqual({ fingerprint: fingerprintOf(m) });
  });

  it("17:00, full squad: the lead and the bench ask, no names", async () => {
    const m = match({ maxPlayers: 13 });
    setWorld(m, [rosterMarker(m, new Date(MON_5PM.getTime() - 60 * 60_000))]);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toContain("squad is full, *13/13*");
    expect(post?.text).not.toContain("1. Player 1");
    expect(post?.text).not.toContain("*Confirmed (13/13):*");
    expect(post?.rosterShown).toBeUndefined();
  });

  it("17:00, full squad, nothing shown: the roster as before, with a marker", async () => {
    const m = match({ maxPlayers: 13 });
    setWorld(m);
    const post = find(await posts(MON_5PM), ":evening-update:");
    expect(post?.text).toContain("*Confirmed (13/13):*\n1. Player 1");
    expect(post?.rosterShown).toEqual({ fingerprint: fingerprintOf(m) });
  });

  it("17:00 on match day, full squad, no teams: the nudge without the names", async () => {
    const m = match({ maxPlayers: 13 });
    setWorld(m, [rosterMarker(m, new Date(TUE_5PM.getTime() - 60 * 60_000))]);
    const post = find(await posts(TUE_5PM), ":evening-update:");
    expect(post?.text).toContain("Squad is locked.");
    expect(post?.text).not.toContain("1. Player 1");
    expect(post?.rosterShown).toBeUndefined();
  });

  it("3 to 4 hours before kickoff: no roster straight after the 17:00 one", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, TUE_5PM)]);
    const post = find(await posts(TUE_6PM), ":chase-pre-kickoff");
    expect(post?.text).toBe(LEAD);
    expect(post?.rosterShown).toBeUndefined();
  });

  it("the last call before kickoff: no roster either, and the roster when it is stale", async () => {
    const m = match();
    setWorld(m, [rosterMarker(m, TUE_6PM)]);
    expect(find(await posts(TUE_8PM), ":pre-kickoff")?.text).toBe(LEAD);

    setWorld(m, [rosterMarker(m, new Date(TUE_8PM.getTime() - 4 * 60 * 60 * 1000))]);
    const stale = find(await posts(TUE_8PM), ":pre-kickoff");
    expect(stale?.text).toBe(MODEL_TEXT);
    expect(stale?.rosterShown).toEqual({ fingerprint: fingerprintOf(m) });
  });
});
