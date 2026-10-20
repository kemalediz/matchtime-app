/**
 * QUOTED-REPLY CONTEXT IN THE GROUPS (slice S4, 2026-10-20).
 *
 * A WhatsApp reply in the players' group or in HQ carries the message it
 * quotes, WHOEVER wrote it. The resolver names it: MatchTime's own post
 * by its stanza id (`SentNotification.waStanzaId`, a BotJob's words), a
 * member's message by the same id (this batch, `AnalyzedMessage` in the
 * players' group, `AdminGroupMessage` in HQ), else the Pi's quoted text
 * and author. `renderGroupReplyContext` is the same block the DM
 * classifiers read (`renderReplyContext`), with no recent-DM list.
 */
import { describe, it, expect } from "vitest";
import {
  GROUP_QUOTE_WORDS_MAX,
  QUOTE_LOOKBACK_MS,
  loadGroupReplyContexts,
  parseGroupQuote,
  quoteForMatch,
  renderGroupReplyContext,
  renderReplyContext,
  type GroupReplyContextDb,
} from "../reply-context";

const NOW = new Date("2026-10-20T18:00:00Z"); // Tue 20 Oct, 19:00 London
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const ORG = "org-fnf";
const GROUP = "120363000000000001@g.us";

interface SentRow {
  key: string;
  kind: string;
  matchId: string | null;
  waMessageId: string | null;
  waStanzaId: string | null;
  text: string | null;
  createdAt: Date;
}

function fakeDb(input: {
  sent?: SentRow[];
  botJobs?: Array<{ id: string; orgId: string; kind: string; text: string; sentAt: Date | null; createdAt: Date }>;
  matches?: Array<{ id: string; date: Date; activity: { name: string; orgId: string } }>;
  analyzed?: Array<{ waMessageId: string; orgId: string; authorUserId: string | null; authorName: string | null; body: string | null; createdAt: Date }>;
  hq?: Array<{ waMessageId: string; orgId: string; senderUserId: string | null; text: string; createdAt: Date }>;
  users?: Array<{ id: string; name: string | null }>;
  fail?: boolean;
}) {
  const calls: string[] = [];
  const db: GroupReplyContextDb = {
    sentNotification: {
      findMany: async (args) => {
        calls.push("sentNotification");
        if (input.fail) throw new Error("db down");
        const gte = args.where.createdAt.gte.getTime();
        return (input.sent ?? []).filter(
          (r) =>
            r.createdAt.getTime() >= gte &&
            args.where.OR.some((c) => {
              if ("waStanzaId" in c && c.waStanzaId !== null) return r.waStanzaId === c.waStanzaId;
              if (r.waStanzaId !== null) return false;
              const w = (c as { waMessageId: string | { contains: string } }).waMessageId;
              return typeof w === "string" ? r.waMessageId === w : (r.waMessageId ?? "").includes(w.contains);
            }),
        );
      },
    },
    botJob: {
      findUnique: async (args) => {
        calls.push("botJob");
        return (input.botJobs ?? []).find((j) => j.id === args.where.id) ?? null;
      },
    },
    match: {
      findMany: async (args) => {
        calls.push("match");
        return (input.matches ?? []).filter((m) => args.where.id.in.includes(m.id));
      },
    },
    analyzedMessage: {
      findMany: async (args) => {
        calls.push("analyzedMessage");
        return (input.analyzed ?? []).filter(
          (r) => r.orgId === args.where.orgId && r.createdAt >= args.where.createdAt.gte && r.waMessageId.includes(args.where.waMessageId.contains),
        );
      },
    },
    adminGroupMessage: {
      findMany: async (args) => {
        calls.push("adminGroupMessage");
        return (input.hq ?? []).filter(
          (r) => r.orgId === args.where.orgId && r.createdAt >= args.where.createdAt.gte && r.waMessageId.includes(args.where.waMessageId.contains),
        );
      },
    },
    user: {
      findMany: async (args) => {
        calls.push("user");
        return (input.users ?? []).filter((u) => args.where.id.in.includes(u.id));
      },
    },
  };
  return { db, calls };
}

const TUE = { id: "m-tue", date: new Date("2026-10-20T19:00:00Z"), activity: { name: "Tuesday 7-a-side", orgId: ORG } };
const LAST_TUE = { id: "m-last", date: new Date("2026-10-13T19:00:00Z"), activity: { name: "Tuesday 7-a-side", orgId: ORG } };

const squadPost = (over: Partial<SentRow> = {}): SentRow => ({
  key: "m-tue:evening-update:2026-10-19",
  kind: "group-message",
  matchId: "m-tue",
  waMessageId: `true_${GROUP}_3EB0SQUAD`,
  waStanzaId: "3EB0SQUAD",
  text: "Tuesday 7-a-side: 12/14\n1. Ali\n2. Bo",
  createdAt: new Date("2026-10-19T17:00:00Z"),
  ...over,
});

describe("parseGroupQuote: the Pi's quote fields, players' group or HQ", () => {
  it("reads the analyze route's names", () => {
    expect(
      parseGroupQuote({ quotedMessageId: " 3EB0A ", quotedBody: "IN", quotedFromMatchTime: false, quotedAuthorName: "Ali", quotedAuthorPhone: "447700900003" }),
    ).toEqual({ id: "3EB0A", text: "IN", fromMatchTime: false, authorName: "Ali", authorPhone: "447700900003" });
  });
  it("reads HQ's names (quotedText)", () => {
    expect(parseGroupQuote({ quotedMessageId: "3EB0B", quotedText: "Teams ready", quotedFromMatchTime: true })).toEqual({
      id: "3EB0B",
      text: "Teams ready",
      fromMatchTime: true,
      authorName: null,
      authorPhone: null,
    });
  });
  it("is null for a message that is not a reply", () => {
    expect(parseGroupQuote({})).toBeNull();
    expect(parseGroupQuote({ quotedBody: "  " })).toBeNull();
  });
});

describe("loadGroupReplyContexts: which message a group reply quotes", () => {
  const base = { orgId: ORG, channel: "group" as const, now: NOW, batch: [] };

  it("a reply to MatchTime's scheduler post: its stored words, time, topic and match, by stanza id", async () => {
    const { db } = fakeDb({ sent: [squadPost()], matches: [TUE] });
    const out = await loadGroupReplyContexts(db, {
      ...base,
      messages: [{ id: "w1", quote: { id: "3EB0SQUAD", text: "Tuesday 7-a-side: 12/1", fromMatchTime: true } }],
    });
    expect(out.get("w1")).toEqual({
      author: null,
      at: new Date("2026-10-19T17:00:00Z"),
      text: "Tuesday 7-a-side: 12/14\n1. Ali\n2. Bo",
      topic: "attendance",
      matchId: "m-tue",
      match: "Tuesday 7-a-side, Tue 20 Oct, 20:00",
    });
  });

  it("a reply to a group BotJob of this club: the job's words, no topic", async () => {
    const { db } = fakeDb({
      sent: [squadPost({ key: "botjob-j1", kind: "group-message", matchId: null, waStanzaId: "3EB0JOB", text: null })],
      botJobs: [{ id: "j1", orgId: ORG, kind: "group", text: "Pay links are live", sentAt: minsAgo(30), createdAt: minsAgo(31) }],
    });
    const out = await loadGroupReplyContexts(db, { ...base, messages: [{ id: "w1", quote: { id: "3EB0JOB", text: "Pay", fromMatchTime: true } }] });
    expect(out.get("w1")).toMatchObject({ author: null, text: "Pay links are live", at: minsAgo(30), topic: null, matchId: null });
  });

  it("another club's BotJob or a DM is never this group's quote: falls back to the Pi", async () => {
    const { db } = fakeDb({
      sent: [squadPost({ key: "botjob-j2", matchId: null, waStanzaId: "3EB0X", text: null })],
      botJobs: [{ id: "j2", orgId: "org-other", kind: "group", text: "theirs", sentAt: minsAgo(5), createdAt: minsAgo(5) }],
    });
    const out = await loadGroupReplyContexts(db, { ...base, messages: [{ id: "w1", quote: { id: "3EB0X", text: "pi words", fromMatchTime: true } }] });
    expect(out.get("w1")).toEqual({ author: null, at: null, text: "pi words", topic: null, matchId: null, match: null });
  });

  it("a scheduler post on another club's match is not ours", async () => {
    const { db } = fakeDb({ sent: [squadPost()], matches: [{ ...TUE, activity: { name: "x", orgId: "org-other" } }] });
    const out = await loadGroupReplyContexts(db, { ...base, messages: [{ id: "w1", quote: { id: "3EB0SQUAD", text: "pi", fromMatchTime: true } }] });
    expect(out.get("w1")).toMatchObject({ author: null, at: null, text: "pi", matchId: null });
  });

  it("a reply to a player's message in THIS batch: that message's sender and words", async () => {
    const { db, calls } = fakeDb({});
    const out = await loadGroupReplyContexts(db, {
      ...base,
      batch: [{ waMessageId: `false_${GROUP}_3EB0IN_447700900003@s.whatsapp.net`, authorName: "Ali Khan", body: "IN", sentAt: minsAgo(1) }],
      messages: [{ id: "w2", quote: { id: "3EB0IN", text: "IN", fromMatchTime: false } }],
    });
    expect(out.get("w2")).toEqual({ author: { name: "Ali Khan" }, at: minsAgo(1), text: "IN", topic: null, matchId: null, match: null });
    expect(calls).toEqual([]);
  });

  it("a reply to an earlier player's message: AnalyzedMessage, with their roster name", async () => {
    const { db } = fakeDb({
      analyzed: [{ waMessageId: `false_${GROUP}_3EB0OLD_4477@s.whatsapp.net`, orgId: ORG, authorUserId: "u-ali", authorName: "ali k 🔥", body: "I'm out tonight lads", createdAt: minsAgo(40) }],
      users: [{ id: "u-ali", name: "Ali Khan" }],
    });
    const out = await loadGroupReplyContexts(db, { ...base, messages: [{ id: "w3", quote: { id: "3EB0OLD", text: "I'm out", fromMatchTime: false } }] });
    expect(out.get("w3")).toEqual({ author: { name: "Ali Khan" }, at: minsAgo(40), text: "I'm out tonight lads", topic: null, matchId: null, match: null });
  });

  it("HQ: another organiser's message from the HQ log", async () => {
    const { db, calls } = fakeDb({
      hq: [{ waMessageId: `false_${GROUP}_3EB0HQ_4478@s.whatsapp.net`, orgId: ORG, senderUserId: "u-raihan", text: "Bilal is out", createdAt: minsAgo(3) }],
      users: [{ id: "u-raihan", name: "Raihan" }],
    });
    const out = await loadGroupReplyContexts(db, { ...base, channel: "hq", messages: [{ id: "h1", quote: { id: "3EB0HQ", text: null, fromMatchTime: false } }] });
    expect(out.get("h1")).toMatchObject({ author: { name: "Raihan" }, text: "Bilal is out", at: minsAgo(3) });
    expect(calls).not.toContain("analyzedMessage");
  });

  it("nothing stored: the Pi's text and author name; a member with no name stays unnamed", async () => {
    const { db } = fakeDb({});
    const out = await loadGroupReplyContexts(db, {
      ...base,
      messages: [
        { id: "a", quote: { id: "3EB0NONE", text: "me too", fromMatchTime: false, authorName: "Bo" } },
        { id: "b", quote: { id: null, text: "hello", fromMatchTime: false } },
        { id: "c", quote: { id: null, text: "Final score 5-7", fromMatchTime: true } },
      ],
    });
    expect(out.get("a")).toEqual({ author: { name: "Bo" }, at: null, text: "me too", topic: null, matchId: null, match: null });
    expect(out.get("b")).toEqual({ author: { name: null }, at: null, text: "hello", topic: null, matchId: null, match: null });
    expect(out.get("c")).toEqual({ author: null, at: null, text: "Final score 5-7", topic: null, matchId: null, match: null });
  });

  it("the Pi's phone finds the roster name before its pushname", async () => {
    const { db } = fakeDb({});
    const out = await loadGroupReplyContexts(db, {
      ...base,
      authorByPhone: async (p) => (p === "447700900004" ? "Bo Diddley" : null),
      messages: [{ id: "a", quote: { id: null, text: "in", fromMatchTime: false, authorName: "bo 🎸", authorPhone: "447700900004" } }],
    });
    expect(out.get("a")).toMatchObject({ author: { name: "Bo Diddley" } });
  });

  it("not a reply: no entry; a stored row older than the lookback is not found", async () => {
    const { db } = fakeDb({ sent: [squadPost({ createdAt: new Date(NOW.getTime() - QUOTE_LOOKBACK_MS - 1000) })], matches: [TUE] });
    const out = await loadGroupReplyContexts(db, {
      ...base,
      messages: [
        { id: "none", quote: null },
        { id: "old", quote: { id: "3EB0SQUAD", text: "pi", fromMatchTime: true } },
      ],
    });
    expect(out.has("none")).toBe(false);
    expect(out.get("old")).toMatchObject({ at: null, text: "pi" });
  });

  it("never throws: a failed read keeps what the Pi said", async () => {
    const { db } = fakeDb({ fail: true });
    const out = await loadGroupReplyContexts(db, { ...base, messages: [{ id: "w", quote: { id: "3EB0SQUAD", text: "pi", fromMatchTime: true } }] });
    expect(out.get("w")).toMatchObject({ author: null, text: "pi", at: null });
  });
});

describe("renderGroupReplyContext: the DM block's wording, for a group message", () => {
  it("the time now alone, when the message is not a reply", () => {
    expect(renderGroupReplyContext({ now: NOW, quoted: null })).toBe("NOW: Tuesday 20 October 2026, 19:00 (club time, London)");
  });

  it("a reply to MatchTime's post: the DM's wording, its match and words", () => {
    const block = renderGroupReplyContext({
      now: NOW,
      quoted: { author: null, at: new Date("2026-10-19T17:00:00Z"), text: "Tuesday 7-a-side: 12/14", topic: "attendance", match: "Tuesday 7-a-side, Tue 20 Oct, 20:00" },
    });
    expect(block).toBe(
      "NOW: Tuesday 20 October 2026, 19:00 (club time, London)\n" +
        "THEY ARE REPLYING TO MatchTime's message of Mon 19 Oct, 18:00 (about: who is playing in Tuesday 7-a-side, Tue 20 Oct, 20:00):\n" +
        '"Tuesday 7-a-side: 12/14"',
    );
  });

  it("a reply to a player's message: their name and time", () => {
    expect(
      renderGroupReplyContext({ now: NOW, quoted: { author: { name: "Ali Khan" }, at: minsAgo(2), text: "I'm out tonight lads", topic: null, match: null } }),
    ).toBe(
      "NOW: Tuesday 20 October 2026, 19:00 (club time, London)\n" +
        "THEY ARE REPLYING TO Ali Khan's message of Tue 20 Oct, 18:58:\n" +
        '"I\'m out tonight lads"',
    );
  });

  it("an unnamed member, time not known; MatchTime, time not known", () => {
    expect(renderGroupReplyContext({ now: NOW, quoted: { author: { name: null }, at: null, text: "hi", topic: null, match: null } })).toContain(
      "THEY ARE REPLYING TO another member's message (when it was sent is not known):",
    );
    expect(renderGroupReplyContext({ now: NOW, quoted: { author: null, at: null, text: "hi", topic: null, match: null } })).toContain(
      "THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):",
    );
  });

  it("caps the words at the group cap", () => {
    const long = "x".repeat(GROUP_QUOTE_WORDS_MAX + 50);
    const block = renderGroupReplyContext({ now: NOW, quoted: { author: null, at: null, text: long, topic: null, match: null } });
    expect(block).toContain(`"${"x".repeat(GROUP_QUOTE_WORDS_MAX)}"`);
    expect(block).not.toContain("x".repeat(GROUP_QUOTE_WORDS_MAX + 1));
  });

  it("is the DM block's wording for a MatchTime quote (one format)", () => {
    const q = { at: new Date("2026-10-19T17:00:00Z"), text: "Can you play?", topic: "tentativeFollowup" as const, match: "Tue" };
    const dm = renderReplyContext({ now: NOW, quoted: q, recent: [], earlier: null });
    expect(renderGroupReplyContext({ now: NOW, quoted: { ...q, author: null } })).toBe(dm);
  });

  it("has no em or en dashes", () => {
    const block = renderGroupReplyContext({ now: NOW, quoted: { author: { name: "A" }, at: minsAgo(1), text: "t", topic: null, match: null } });
    expect(block).not.toMatch(/[–—]/);
  });
});

describe("quoteForMatch works for a group quote too", () => {
  it("keeps a quote naming the match acted on or none, drops another match's", () => {
    const q = { author: null, at: null, text: "x", topic: null, matchId: "m-last", match: null };
    expect(quoteForMatch(q, "m-tue")).toBeNull();
    expect(quoteForMatch(q, "m-last")).toBe(q);
    expect(quoteForMatch({ ...q, matchId: null }, "m-tue")).not.toBeNull();
  });
});

void LAST_TUE;
