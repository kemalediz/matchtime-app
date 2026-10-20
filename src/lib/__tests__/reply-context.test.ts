/**
 * WHICH MATCHTIME MESSAGE A DM REPLY QUOTES (quoted-reply context, slices
 * S0 and S1, 2026-10-20). Design: Kemal approved 2026-10-20.
 *
 * When a player swipe-replies to one of MatchTime's DMs, the Pi forwards
 * the quoted message's bare stanza id ("3EB0..."), its text, and whether
 * it was MatchTime's own. The resolver turns that into the message we sent:
 * when, its words, what it was about (its key's topic) and its match.
 * Nothing reads it yet but a log line: no classifier sees it in S0/S1.
 *
 * The resolver is DB-free; the client is handed in, so this suite uses an
 * in-memory fake. The real queries run against Postgres in
 * e2e/helpers/reply-context-lib-tests.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  logDmQuote,
  parseDmQuote,
  quoteLogLine,
  resolveQuotedBotMessage,
  QUOTE_LOOKBACK_MS,
  QUOTED_TEXT_MAX,
  type ReplyContextDb,
} from "../reply-context";

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);

const ALI = { id: "u-ali", phoneNumber: "+447700900003" };
const BO = { id: "u-bo", phoneNumber: "+447700900004" };
const ALI_CHAT = "447700900003@s.whatsapp.net";

interface Row {
  key: string;
  kind: string;
  matchId: string | null;
  targetUser: string | null;
  waMessageId: string | null;
  waStanzaId: string | null;
  text: string | null;
  createdAt: Date;
}

interface Clause {
  waStanzaId?: string | null;
  waMessageId?: string | { contains: string };
}

function matches(row: Row, c: Clause): boolean {
  if ("waStanzaId" in c && row.waStanzaId !== c.waStanzaId) return false;
  if ("waMessageId" in c) {
    const want = c.waMessageId;
    if (typeof want === "string") return row.waMessageId === want;
    if (want && typeof want === "object") return (row.waMessageId ?? "").includes(want.contains);
  }
  return true;
}

function fakeDb(input: {
  rows: Row[];
  botJobs?: Array<{ id: string; kind: string; phone: string | null; text: string; sentAt: Date | null; createdAt: Date }>;
  users?: Array<{ id: string; phoneNumber: string | null }>;
}) {
  const calls = { sentNotification: 0, botJob: 0, user: 0 };
  const db: ReplyContextDb = {
    sentNotification: {
      findMany: async (args) => {
        calls.sentNotification += 1;
        const gte = args.where.createdAt.gte.getTime();
        return input.rows
          .filter((r) => r.createdAt.getTime() >= gte && args.where.OR.some((c) => matches(r, c as Clause)))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take);
      },
    },
    botJob: {
      findUnique: async (args) => {
        calls.botJob += 1;
        return input.botJobs?.find((j) => j.id === args.where.id) ?? null;
      },
    },
    user: {
      findUnique: async (args) => {
        calls.user += 1;
        const u = (input.users ?? [ALI, BO]).find((x) => x.id === args.where.id);
        return u ? { phoneNumber: u.phoneNumber } : null;
      },
    },
  };
  return { db, calls };
}

const payChase = (over: Partial<Row> = {}): Row => ({
  key: "m-tue:pay-chase:u-ali:2026-10-17",
  kind: "dm",
  matchId: "m-tue",
  targetUser: ALI.id,
  waMessageId: `true_${ALI_CHAT}_3EB0PAY`,
  waStanzaId: "3EB0PAY",
  text: "Hi Ali, you owe £6 for Tuesday. Pay here: https://mt.example/p/x",
  createdAt: hoursAgo(20),
  ...over,
});

const quote = (over: Partial<{ id: string | null; text: string | null; fromMatchTime: boolean }> = {}) => ({
  id: "3EB0PAY",
  text: "Hi Ali, you owe £6 for Tuesday...",
  fromMatchTime: true,
  ...over,
});

describe("parseDmQuote: the Pi's quote fields on /api/whatsapp/dm-reply", () => {
  it("reads all three", () => {
    expect(
      parseDmQuote({ quotedMessageId: " 3EB0PAY ", quotedText: "Hi Ali", quotedFromMatchTime: true }),
    ).toEqual({ id: "3EB0PAY", text: "Hi Ali", fromMatchTime: true });
  });

  it("is null for a DM that is not a reply, which is what an older Pi always sends", () => {
    expect(parseDmQuote({ phone: "447700900003", body: "done", waMessageId: "w1" })).toBeNull();
  });

  it("ignores fields of the wrong type, and caps the text", () => {
    expect(parseDmQuote({ quotedMessageId: 7, quotedText: 9, quotedFromMatchTime: "yes" })).toBeNull();
    const long = parseDmQuote({ quotedText: "x".repeat(QUOTED_TEXT_MAX + 10), quotedFromMatchTime: false });
    expect(long?.text).toHaveLength(QUOTED_TEXT_MAX);
    expect(long).toMatchObject({ id: null, fromMatchTime: false });
  });
});

describe("resolveQuotedBotMessage", () => {
  it("a swipe-reply to a scheduler DM resolves to its stored words, topic, match and time", async () => {
    const row = payChase();
    const { db } = fakeDb({ rows: [row] });
    const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
    expect(got).toEqual({
      key: row.key,
      sentAt: row.createdAt,
      text: row.text,
      topic: "paymentCollection",
      matchId: "m-tue",
    });
  });

  it("finds a row sent before the stanza column was filled (legacy serialised id only)", async () => {
    const { db } = fakeDb({ rows: [payChase({ waStanzaId: null })] });
    const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
    expect(got?.key).toBe("m-tue:pay-chase:u-ali:2026-10-17");
  });

  it("a quoted id that arrives serialised is compared on its stanza id", async () => {
    const { db } = fakeDb({ rows: [payChase()] });
    const got = await resolveQuotedBotMessage(db, {
      quote: quote({ id: `true_${ALI_CHAT}_3EB0PAY` }),
      phones: ["447700900003"],
      now: NOW,
    });
    expect(got?.key).toBe("m-tue:pay-chase:u-ali:2026-10-17");
  });

  it("does not take a row whose id only CONTAINS the stanza id as part of a longer one", async () => {
    const { db } = fakeDb({ rows: [payChase({ waStanzaId: null, waMessageId: `true_${ALI_CHAT}_3EB0PAYX` })] });
    const got = await resolveQuotedBotMessage(db, { quote: quote({ fromMatchTime: false }), phones: ["447700900003"], now: NOW });
    expect(got).toBeNull();
  });

  it("a scheduler DM with no stored words (sent before S0) falls back to the Pi's quoted text", async () => {
    const { db } = fakeDb({ rows: [payChase({ text: null })] });
    const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
    expect(got).toMatchObject({ key: "m-tue:pay-chase:u-ali:2026-10-17", text: "Hi Ali, you owe £6 for Tuesday...", topic: "paymentCollection" });
  });

  it("a queued BotJob DM resolves to the job's words, owned by the job's phone", async () => {
    const sent = hoursAgo(3);
    const { db } = fakeDb({
      rows: [payChase({ key: "botjob-j1", matchId: null, targetUser: null, text: null, waStanzaId: "3EB0JOB", createdAt: hoursAgo(3.1) })],
      botJobs: [{ id: "j1", kind: "dm", phone: "447700900003", text: "💷 Ali, match fee is £5.", sentAt: sent, createdAt: hoursAgo(4) }],
    });
    const got = await resolveQuotedBotMessage(db, { quote: quote({ id: "3EB0JOB" }), phones: ["447700900003"], now: NOW });
    expect(got).toEqual({ key: "botjob-j1", sentAt: sent, text: "💷 Ali, match fee is £5.", topic: null, matchId: null });
  });

  it("the tentative follow-up has its own topic", async () => {
    const { db } = fakeDb({ rows: [payChase({ key: "m-tue:tentative-followup:u-ali", text: "Can you play Tuesday?" })] });
    const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
    expect(got?.topic).toBe("tentativeFollowup");
  });

  describe("only this person's chat", () => {
    it("a scheduler DM to somebody else is not theirs: quote-only when the Pi says it was MatchTime's", async () => {
      const { db } = fakeDb({ rows: [payChase({ targetUser: BO.id })] });
      const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
      expect(got).toEqual({ key: null, sentAt: null, text: "Hi Ali, you owe £6 for Tuesday...", topic: null, matchId: null });
    });

    it("a group post (no recipient) is never a DM's quote", async () => {
      const { db } = fakeDb({ rows: [payChase({ kind: "group-message", targetUser: null })] });
      const got = await resolveQuotedBotMessage(db, { quote: quote({ fromMatchTime: false }), phones: ["447700900003"], now: NOW });
      expect(got).toBeNull();
    });

    it("a BotJob to another phone is not theirs", async () => {
      const { db } = fakeDb({
        rows: [payChase({ key: "botjob-j2", targetUser: null, waStanzaId: "3EB0JOB" })],
        botJobs: [{ id: "j2", kind: "dm", phone: "447700900004", text: "Bo's", sentAt: null, createdAt: hoursAgo(5) }],
      });
      const got = await resolveQuotedBotMessage(db, { quote: quote({ id: "3EB0JOB", fromMatchTime: false }), phones: ["447700900003"], now: NOW });
      expect(got).toBeNull();
    });

    it("the alt phone counts, in either written form", async () => {
      const { db } = fakeDb({ rows: [payChase()] });
      const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["", undefined, "+44 7700 900003"], now: NOW });
      expect(got?.key).toBe("m-tue:pay-chase:u-ali:2026-10-17");
    });

    it("with no phone at all nothing stored can be shown to be theirs", async () => {
      const { db, calls } = fakeDb({ rows: [payChase()] });
      const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: [], now: NOW });
      expect(got?.key).toBeNull();
      expect(calls.sentNotification).toBe(0);
    });
  });

  it("a message older than the lookback is not found", async () => {
    const { db } = fakeDb({ rows: [payChase({ createdAt: new Date(NOW.getTime() - QUOTE_LOOKBACK_MS - 1000) })] });
    const got = await resolveQuotedBotMessage(db, { quote: quote(), phones: ["447700900003"], now: NOW });
    expect(got?.key).toBeNull();
  });

  it("no id, but the Pi says it was MatchTime's: the Pi's text, time and topic unknown", async () => {
    const { db, calls } = fakeDb({ rows: [payChase()] });
    const got = await resolveQuotedBotMessage(db, { quote: quote({ id: null }), phones: ["447700900003"], now: NOW });
    expect(got).toEqual({ key: null, sentAt: null, text: "Hi Ali, you owe £6 for Tuesday...", topic: null, matchId: null });
    expect(calls.sentNotification).toBe(0);
  });

  it("a quote of somebody else's message (not MatchTime's, not ours) is null", async () => {
    const { db } = fakeDb({ rows: [] });
    expect(
      await resolveQuotedBotMessage(db, { quote: quote({ fromMatchTime: false }), phones: ["447700900003"], now: NOW }),
    ).toBeNull();
  });
});

describe("the S1 log line: ids, topic, match and resolved yes/no, never the words", () => {
  const resolved = {
    key: "m-tue:pay-chase:u-ali:2026-10-17",
    sentAt: hoursAgo(20),
    text: "Hi Ali, you owe £6 for Tuesday.",
    topic: "paymentCollection" as const,
    matchId: "m-tue",
  };

  it("names the ids, the topic and the match", () => {
    const line = quoteLogLine({ waMessageId: "w1", quote: quote(), resolved });
    expect(line).toContain("msg=w1");
    expect(line).toContain("quoted=3EB0PAY");
    expect(line).toContain("fromMatchTime=yes");
    expect(line).toContain("resolved=yes");
    expect(line).toContain(`key=${resolved.key}`);
    expect(line).toContain("topic=paymentCollection");
    expect(line).toContain("match=m-tue");
  });

  it("carries no message text, theirs or ours", () => {
    const line = quoteLogLine({ waMessageId: "w1", quote: quote(), resolved });
    expect(line).not.toMatch(/owe|Tuesday|Hi Ali/);
  });

  it("says resolved=no for a quote-only or unknown quote", () => {
    expect(quoteLogLine({ waMessageId: "w1", quote: quote({ id: null }), resolved: { ...resolved, key: null, topic: null, matchId: null, sentAt: null } })).toMatch(
      /quoted=- .*resolved=no/,
    );
    expect(quoteLogLine({ waMessageId: "w1", quote: quote({ fromMatchTime: false }), resolved: null })).toMatch(/fromMatchTime=no resolved=no/);
  });
});

describe("logDmQuote: the dm-reply route's one call", () => {
  it("does nothing for a DM that is not a reply", async () => {
    const { db, calls } = fakeDb({ rows: [payChase()] });
    const log = vi.fn();
    const out = await logDmQuote(db, { body: { body: "done" }, waMessageId: "w1", phones: ["447700900003"], now: NOW, log });
    expect(out).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(calls.sentNotification).toBe(0);
  });

  it("resolves and logs one line for a reply", async () => {
    const { db } = fakeDb({ rows: [payChase()] });
    const log = vi.fn();
    const out = await logDmQuote(db, {
      body: { quotedMessageId: "3EB0PAY", quotedText: "Hi Ali", quotedFromMatchTime: true },
      waMessageId: "w1",
      phones: ["447700900003"],
      now: NOW,
      log,
    });
    expect(out?.key).toBe("m-tue:pay-chase:u-ali:2026-10-17");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^\[dm-reply\] quote .*resolved=yes/);
  });

  it("never throws: a failed read is logged and the DM carries on", async () => {
    const { db } = fakeDb({ rows: [] });
    db.sentNotification.findMany = async () => {
      throw new Error("db down");
    };
    const log = vi.fn();
    const error = vi.fn();
    const out = await logDmQuote(db, {
      body: { quotedMessageId: "3EB0PAY", quotedFromMatchTime: true },
      waMessageId: "w1",
      phones: ["447700900003"],
      now: NOW,
      log,
      error,
    });
    expect(out).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).not.toMatch(/Hi Ali/);
  });
});
