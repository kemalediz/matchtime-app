/**
 * THE ONE WEEK-OF-CHAT LOADER (Kemal, 2026-11-10: "recent chat should be
 * all messages since last 1 week"), read by the open answer and the rating
 * adjuster (`week-chat.ts`).
 *
 * The db is a small in-memory fake that honours the filters, `orderBy` and
 * `take` the loader sends, so these prove what a real query returns: the
 * 7-day window, the newest 300 oldest first, MatchTime's own lines found
 * where they really live and labelled MatchTime, one line per send, and the
 * players' group and HQ never mixed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown> & { createdAt?: Date };
const T: Record<string, Row[]> = {};

const NOW = new Date("2026-11-10T18:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const ORG = "org-a";
const OTHER = "org-b";
const GROUP = "111@g.us";

/** The subset of Prisma's `where` the loader uses. */
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((c) => matches(row, c as Record<string, unknown>))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((c) => matches(row, c))) return false;
      continue;
    }
    if (k === "match") {
      const orgId = ((cond as { activity: { orgId: string } }).activity).orgId;
      if (!row.matchId || MATCH_ORG[row.matchId as string] !== orgId) return false;
      continue;
    }
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("gte" in c && !(v instanceof Date && v >= (c.gte as Date))) return false;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
      if ("startsWith" in c && !(typeof v === "string" && v.startsWith(c.startsWith as string))) return false;
      if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function table(name: string) {
  return {
    findMany: async (args: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take?: number }) => {
      let rows = (T[name] ?? []).filter((r) => matches(r, args.where));
      const [[field, dir] = ["createdAt", "asc"]] = Object.entries(args.orderBy ?? {});
      rows = [...rows].sort((a, b) => ((a[field] as Date).getTime() - (b[field] as Date).getTime()) * (dir === "desc" ? -1 : 1));
      return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
    },
  };
}

const MATCH_ORG: Record<string, string> = { "m-a": ORG, "m-b": OTHER };

vi.mock("@/lib/db", () => ({
  db: {
    analyzedMessage: table("analyzedMessage"),
    adminGroupMessage: table("adminGroupMessage"),
    sentNotification: table("sentNotification"),
    botJob: table("botJob"),
    user: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        (T.user ?? []).filter((u) => args.where.id.in.includes(u.id as string)),
    },
  },
}));

import { loadWeekChat, playersWeekChat, hqWeekChat, asChatLines, WEEK_CHAT_MS } from "@/lib/week-chat";
import { HQ_LOG_TTL_MS } from "@/lib/admin-group-log";

const since = new Date(NOW.getTime() - WEEK_CHAT_MS);
const said = (id: string, h: number, userId: string | null, body: string, over: Row = {}): Row => ({
  waMessageId: id,
  orgId: ORG,
  groupId: GROUP,
  authorUserId: userId,
  body,
  createdAt: ago(h),
  ...over,
});
const hq = (id: string, h: number, userId: string | null, text: string, over: Row = {}): Row => ({
  waMessageId: id,
  orgId: ORG,
  senderUserId: userId,
  fromMatchTime: false,
  text,
  createdAt: ago(h),
  ...over,
});
const note = (key: string, kind: string, h: number, text: string | null, matchId: string | null = null): Row => ({ key, kind, matchId, text, createdAt: ago(h) });
const job = (orgId: string, kind: string, h: number, text: string): Row => ({ orgId, kind, text, sentAt: ago(h), createdAt: ago(h) });

beforeEach(() => {
  for (const k of Object.keys(T)) delete T[k];
  T.user = [
    { id: "u-ali", name: "Ali Kaya" },
    { id: "u-can", name: "Can Demir" },
  ];
});

describe("the window and the cap", () => {
  it("keeps the last 7 days only", async () => {
    T.analyzedMessage = [said("w1", 24 * 8, "u-ali", "eight days ago"), said("w2", 24 * 6, "u-ali", "six days ago"), said("w3", 1, "u-can", "an hour ago")];
    const lines = await loadWeekChat({ orgId: ORG, channel: "group", since, includeMatchTime: true });
    expect(lines.map((l) => l.body)).toEqual(["six days ago", "an hour ago"]);
  });

  it("with 400 lines in the week, the NEWEST 300, oldest first", async () => {
    T.analyzedMessage = Array.from({ length: 400 }, (_, i) => said(`w${i}`, (400 - i) * 0.4, "u-ali", `message ${i}`));
    const lines = await loadWeekChat({ orgId: ORG, channel: "group", since, includeMatchTime: true });
    expect(lines).toHaveLength(300);
    expect(lines[0].body).toBe("message 100");
    expect(lines[299].body).toBe("message 399");
  });

  it("the cap counts MatchTime's lines too, and the order interleaves them by time", async () => {
    T.analyzedMessage = Array.from({ length: 300 }, (_, i) => said(`w${i}`, 100 - i * 0.3, "u-ali", `member ${i}`));
    // member i was said (100 - 0.3i) hours ago: 166 at 50.2h, 167 at 49.9h.
    T.sentNotification = [note(`greply:${ORG}:x1`, "group-reply", 0.5, "MatchTime newest"), note(`greply:${ORG}:x2`, "group-reply", 50, "MatchTime midweek")];
    const lines = await loadWeekChat({ orgId: ORG, channel: "group", since, includeMatchTime: true });
    expect(lines).toHaveLength(300);
    // 302 in the week: the two oldest go.
    expect(lines[0].body).toBe("member 2");
    expect(lines[299]).toMatchObject({ body: "MatchTime newest", fromMatchTime: true });
    const mid = lines.findIndex((l) => l.body === "MatchTime midweek");
    expect(lines[mid - 1].body).toBe("member 166");
    expect(lines[mid + 1].body).toBe("member 167");
  });
});

describe("MatchTime's own lines in the players' group, and only this club's", () => {
  beforeEach(() => {
    T.analyzedMessage = [said("w1", 5, "u-ali", "@Match Time who's in?"), said("w2", 3, null, "unresolved member")];
    T.sentNotification = [
      note(`greply:${ORG}:w1`, "group-reply", 4.99, "16 of 18 for Fri. 2 places left."),
      note("m-a:pre-kickoff", "group-message", 2, "Tonight 20:30 at Goals", "m-a"),
      note(`org-${ORG}:payments-live:acct`, "group-message", 1.5, "Payments are live"),
      // Not ours: another club's reply and match post, an HQ post, a DM, a
      // marker with no words, and the claim row of a queued post (read from
      // its BotJob instead).
      note(`greply:${OTHER}:z`, "group-reply", 2, "other club's reply"),
      note("m-b:pre-kickoff", "group-message", 2, "other club's post", "m-b"),
      note(`hqreply:${ORG}:h`, "admin-group-reply", 2, "an HQ reply"),
      note("dm-key", "dm", 2, "a DM"),
      note("m-a:ask-score", "group-message", 2, null, "m-a"),
      note("botjob-j1", "group-message", 1, "queued post", "m-a"),
    ];
    T.botJob = [job(ORG, "group", 1, "queued post"), job(ORG, "dm", 1, "a queued DM"), job(ORG, "admin-group", 1, "a queued HQ post"), job(OTHER, "group", 1, "other club's job")];
  });

  it("finds its replies, its scheduled posts and its queued posts, once each, labelled MatchTime", async () => {
    const lines = asChatLines(await loadWeekChat({ orgId: ORG, channel: "group", groupId: GROUP, since, includeMatchTime: true }));
    expect(lines.map((l) => `${l.author}: ${l.body}`)).toEqual([
      "Ali Kaya: @Match Time who's in?",
      "MatchTime: 16 of 18 for Fri. 2 places left.",
      "null: unresolved member",
      "MatchTime: Tonight 20:30 at Goals",
      "MatchTime: Payments are live",
      "MatchTime: queued post",
    ]);
  });

  it("members only when asked (the rating adjuster): no MatchTime line", async () => {
    const lines = await loadWeekChat({ orgId: ORG, channel: "group", since, includeMatchTime: false });
    expect(lines.every((l) => !l.fromMatchTime)).toBe(true);
    expect(lines).toHaveLength(2);
  });
});

describe("the two groups never mix", () => {
  beforeEach(() => {
    T.analyzedMessage = [said("w1", 2, "u-ali", "players' chat")];
    T.adminGroupMessage = [
      hq("h1", 3, "u-can", "HQ chat"),
      hq("mt:teams:m-a:1", 2.5, null, "Teams ready, reply YES", { fromMatchTime: true }),
      // The players' group's rows kept in the same table: never HQ's.
      hq("mt:group:ask:1", 2, null, "players' group question", { fromMatchTime: true }),
      hq("group:w9", 2, "u-ali", "players' group organiser line"),
      hq("h-other", 1, "u-can", "other club HQ", { orgId: OTHER }),
    ];
    T.sentNotification = [
      note(`hqreply:${ORG}:h1`, "admin-group-reply", 2.9, "Done: Faris out."),
      // The log row and the send of one HQ question: one line.
      note(`hqreply:${ORG}:h0`, "admin-group-reply", 2.5 - 1 / 60, "Teams ready, reply YES"),
      note(`greply:${ORG}:w1`, "group-reply", 1.9, "players' reply"),
    ];
    T.botJob = [job(ORG, "admin-group", 1, "HQ queued"), job(ORG, "group", 1, "players' queued")];
  });

  it("HQ reads HQ's log and MatchTime's HQ sends, never the players' group", async () => {
    const lines = await hqWeekChat({ orgId: ORG, now: NOW, messageId: "none" });
    expect(lines.map((l) => `${l.author}: ${l.body}`)).toEqual([
      "Can Demir: HQ chat",
      "MatchTime: Done: Faris out.",
      "MatchTime: Teams ready, reply YES",
      "MatchTime: HQ queued",
    ]);
  });

  it("HQ's log keeps the week the loader reads (it kept one day until 2026-11-10)", () => {
    expect(HQ_LOG_TTL_MS).toBeGreaterThanOrEqual(WEEK_CHAT_MS);
  });

  it("HQ leaves out the message being answered (it is shown once, last)", async () => {
    const lines = await hqWeekChat({ orgId: ORG, now: NOW, messageId: "h1" });
    expect(lines.map((l) => l.body)).not.toContain("HQ chat");
  });

  it("the players' group reads its own lines and sends, never HQ's", async () => {
    const lines = await playersWeekChat({ orgId: ORG, groupId: GROUP, now: NOW, batch: [] });
    expect(lines.map((l) => `${l.author}: ${l.body}`)).toEqual(["Ali Kaya: players' chat", "MatchTime: players' reply", "MatchTime: players' queued"]);
  });
});

describe("the players' group's week for one request", () => {
  it("adds this batch's messages not yet stored, with their WhatsApp time, and leaves them out of the query", async () => {
    T.analyzedMessage = [said("w1", 2, "u-ali", "earlier"), said("b1", 0, "u-can", "stored copy, not shown twice")];
    const lines = await playersWeekChat({
      orgId: ORG,
      groupId: GROUP,
      now: NOW,
      batch: [
        { waMessageId: "b1", author: "Can Demir", body: "@Match Time what did Ali say?", timestamp: ago(0.01).toISOString(), stored: false },
        { waMessageId: "b0", author: "Ali Kaya", body: "replayed, stored already", timestamp: ago(0.02).toISOString(), stored: true },
      ],
    });
    expect(lines).toEqual([
      { author: "Ali Kaya", body: "earlier", at: ago(2) },
      { author: "Can Demir", body: "@Match Time what did Ali say?", at: ago(0.01) },
    ]);
  });

  it("only this WhatsApp group's stored lines", async () => {
    T.analyzedMessage = [said("w1", 2, "u-ali", "ours"), said("w2", 2, "u-ali", "another group of the club", { groupId: "222@g.us" })];
    const lines = await playersWeekChat({ orgId: ORG, groupId: GROUP, now: NOW, batch: [] });
    expect(lines.map((l) => l.body)).toEqual(["ours"]);
  });

  it("an author is the roster name, never a WhatsApp pushname; an unknown user has none", async () => {
    T.analyzedMessage = [said("w1", 2, "u-ghost", "who am I", { authorName: "Ali Khan" })];
    const lines = await playersWeekChat({ orgId: ORG, groupId: GROUP, now: NOW, batch: [] });
    expect(lines).toEqual([{ author: null, body: "who am I", at: ago(2) }]);
  });
});
