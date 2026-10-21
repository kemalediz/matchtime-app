/**
 * Answering MatchTime's partner-club pairing notice in WhatsApp
 * (Kemal, 2026-10-21: "whatsapp reply like pressing 1 or 2 should also do
 * the same job"). `src/lib/pairing-reply.ts`.
 *
 *   - the reply is read by the model against the notice (its words are the
 *     context); nothing matches "1" or "2";
 *   - a swipe-reply or a reaction acts on THAT notice's pairing and club
 *     only (one owner of both clubs gets two notices);
 *   - an unquoted reply with two pairings waiting does not guess: it asks
 *     which;
 *   - the action is `actOnPartnership`, and its refusals are what the
 *     person hears (owner-only for an admin).
 */
import { describe, expect, it, vi } from "vitest";
import {
  PAIRING_REPLY_MIN_CONFIDENCE,
  PAIRING_REPLY_SYSTEM_PROMPT,
  buildPairingReplyUserTurn,
  classifyPairingReply,
  pairingReplyText,
  parsePairingReplyIntent,
  runPairingReaction,
  runPairingReplyDm,
  type PairingDmDeps,
  type PairingNotice,
  type PairingReactionDeps,
} from "../pairing-reply";
import { pairingNoticeKey, parsePairingNoticeKey, waitingForSide } from "../club-partnership-rules";
import type { QuotedBotMessage } from "../reply-context";

const FRIDAY: PairingNotice = { partnershipId: "p1", orgId: "friday", club: "Friday MT Community", other: "MT Test", lang: "en" };
const TEST_SIDE: PairingNotice = { partnershipId: "p1", orgId: "mttest", club: "MT Test", other: "Friday MT Community", lang: "en" };
const quote = (key: string | null): QuotedBotMessage => ({ key, sentAt: new Date("2026-10-21T15:00:00Z"), text: "🤝 MatchTime has paired ...", topic: null, matchId: null });

function dmDeps(over: Partial<PairingDmDeps> = {}): PairingDmDeps & { act: ReturnType<typeof vi.fn>; classify: ReturnType<typeof vi.fn> } {
  return {
    quotedNotice: vi.fn(async () => null),
    waitingNotices: vi.fn(async () => []),
    classify: vi.fn(async () => "accept" as const),
    act: vi.fn(async (n: PairingNotice, action: "accept" | "decline") => ({ outcome: `pairing-${action}`, reply: `${action} ${n.orgId}` })),
    ...over,
  } as never;
}

describe("the notice key", () => {
  it("names the pairing and the club, and reads back", () => {
    expect(pairingNoticeKey("p1", "friday")).toBe("pairing:p1:friday");
    expect(parsePairingNoticeKey("pairing:p1:friday")).toEqual({ partnershipId: "p1", orgId: "friday" });
    expect(parsePairingNoticeKey("m1:fee-confirm")).toBeNull();
    expect(parsePairingNoticeKey("pairing:p1")).toBeNull();
    expect(parsePairingNoticeKey(null)).toBeNull();
  });

  it("a side is waiting while the pairing is proposed and it has not accepted", () => {
    const row = { askerOrgId: "a", partnerOrgId: "b", status: "proposed", askerAcceptedAt: new Date(), partnerAcceptedAt: null };
    expect(waitingForSide(row, "a")).toBe(false);
    expect(waitingForSide(row, "b")).toBe(true);
    expect(waitingForSide({ ...row, status: "active" }, "b")).toBe(false);
    expect(waitingForSide(row, "c")).toBe(false);
  });
});

describe("the model reads the reply against the notice", () => {
  it("the prompt names both answers and the menu the notice offers, with no long dashes", () => {
    expect(PAIRING_REPLY_SYSTEM_PROMPT).toContain('"accept"');
    expect(PAIRING_REPLY_SYSTEM_PROMPT).toContain('"decline"');
    expect(PAIRING_REPLY_SYSTEM_PROMPT).toContain('"neither"');
    expect(PAIRING_REPLY_SYSTEM_PROMPT).toMatch(/reply 1/);
    expect(PAIRING_REPLY_SYSTEM_PROMPT).not.toMatch(/[–—]/);
  });

  it("the user turn carries the pairing, the chat context and the reply under its header", () => {
    const user = buildPairingReplyUserTurn("1", {
      pairings: [{ club: "Friday MT Community", other: "MT Test" }],
      replyContext: { now: new Date("2026-10-21T15:05:00Z"), quoted: { at: new Date("2026-10-21T15:00:00Z"), text: "Reply *1* to accept", topic: null, match: null }, recent: [], earlier: null },
    });
    expect(user).toContain("Friday MT Community");
    expect(user).toContain("MT Test");
    expect(user).toContain("THEY ARE REPLYING TO");
    expect(user.trim().endsWith("THEIR REPLY:\n1")).toBe(true);
  });

  it("the JSON contract: an intent outside the enum, unparseable text or low confidence is neither", () => {
    expect(parsePairingReplyIntent('{"intent":"accept","confidence":0.95,"reasoning":"1"}').intent).toBe("accept");
    expect(parsePairingReplyIntent('```json\n{"intent":"decline","confidence":0.9,"reasoning":"2"}\n```').intent).toBe("decline");
    expect(parsePairingReplyIntent('{"intent":"yes","confidence":1}').intent).toBe("neither");
    expect(parsePairingReplyIntent("sure!").intent).toBe("neither");
    expect(parsePairingReplyIntent(`{"intent":"accept","confidence":${PAIRING_REPLY_MIN_CONFIDENCE - 0.01}}`).intent).toBe("neither");
  });

  it("fails closed: a throwing model, no model, or an empty reply is neither", async () => {
    const ctx = { pairings: [{ club: "A", other: "B" }] };
    expect(await classifyPairingReply("1", ctx, async () => { throw new Error("overloaded"); })).toBe("neither");
    expect(await classifyPairingReply("1", ctx, null)).toBe("neither");
    expect(await classifyPairingReply("  ", ctx, async () => '{"intent":"accept","confidence":1}')).toBe("neither");
    expect(await classifyPairingReply("1", ctx, async () => '{"intent":"accept","confidence":1}')).toBe("accept");
  });
});

describe("a DM reply", () => {
  it("nothing waiting and no pairing quoted: not ours, and the model is never asked", async () => {
    const deps = dmDeps();
    expect(await runPairingReplyDm({ quoted: null }, deps)).toBeNull();
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("a swipe-reply to another of MatchTime's messages: not ours, no model", async () => {
    const deps = dmDeps({ waitingNotices: vi.fn(async () => [FRIDAY]) });
    expect(await runPairingReplyDm({ quoted: quote("m1:fee-ask") }, deps)).toBeNull();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.act).not.toHaveBeenCalled();
  });

  it("a swipe-reply to one club's notice acts on that club's side only, though both wait (one owner, two notices)", async () => {
    const deps = dmDeps({
      quotedNotice: vi.fn(async () => TEST_SIDE),
      waitingNotices: vi.fn(async () => [FRIDAY, TEST_SIDE]),
    });
    const r = await runPairingReplyDm({ quoted: quote("botjob-j2") }, deps);
    expect(deps.classify).toHaveBeenCalledWith([TEST_SIDE], expect.objectContaining({ key: "botjob-j2" }));
    expect(deps.act).toHaveBeenCalledTimes(1);
    expect(deps.act).toHaveBeenCalledWith(TEST_SIDE, "accept");
    expect(r).toEqual({ handled: "pairing-reply", outcome: "pairing-accept", reply: "accept mttest", orgId: "mttest" });
  });

  it("a decline is a decline", async () => {
    const deps = dmDeps({ quotedNotice: vi.fn(async () => FRIDAY), classify: vi.fn(async () => "decline" as const) });
    await runPairingReplyDm({ quoted: quote("botjob-j1") }, deps);
    expect(deps.act).toHaveBeenCalledWith(FRIDAY, "decline");
  });

  it("neither: falls through to the rest of the DM handlers, nothing done", async () => {
    const deps = dmDeps({ quotedNotice: vi.fn(async () => FRIDAY), classify: vi.fn(async () => "neither" as const) });
    expect(await runPairingReplyDm({ quoted: quote("botjob-j1") }, deps)).toBeNull();
    expect(deps.act).not.toHaveBeenCalled();
  });

  it("unquoted, one pairing waiting: the model reads it against the recent messages, then it acts", async () => {
    const deps = dmDeps({ waitingNotices: vi.fn(async () => [FRIDAY]) });
    const r = await runPairingReplyDm({ quoted: null }, deps);
    expect(deps.classify).toHaveBeenCalledWith([FRIDAY], null);
    expect(deps.act).toHaveBeenCalledWith(FRIDAY, "accept");
    expect(r?.orgId).toBe("friday");
  });

  it("unquoted, two pairings waiting: does not guess, asks which, acts on neither", async () => {
    const deps = dmDeps({ waitingNotices: vi.fn(async () => [FRIDAY, TEST_SIDE]) });
    const r = await runPairingReplyDm({ quoted: null }, deps);
    expect(deps.act).not.toHaveBeenCalled();
    expect(r?.handled).toBe("pairing-which");
    expect(r?.reply).toContain("Which pairing is that for?");
    expect(r?.reply).toContain("*Friday MT Community* with *MT Test*");
    expect(r?.reply).toContain("*MT Test* with *Friday MT Community*");
  });

  it("unquoted, two waiting, and it is not an answer: silent", async () => {
    const deps = dmDeps({ waitingNotices: vi.fn(async () => [FRIDAY, TEST_SIDE]), classify: vi.fn(async () => "neither" as const) });
    expect(await runPairingReplyDm({ quoted: null }, deps)).toBeNull();
  });

  it("a quote the Pi alone knew (no key): read as unquoted", async () => {
    const deps = dmDeps({ waitingNotices: vi.fn(async () => [FRIDAY]) });
    await runPairingReplyDm({ quoted: quote(null) }, deps);
    expect(deps.quotedNotice).not.toHaveBeenCalled();
    expect(deps.act).toHaveBeenCalledWith(FRIDAY, "accept");
  });
});

describe("what the person hears, from actOnPartnership's result", () => {
  it("accepted while the other owner has not: waiting for them; both now: active", () => {
    expect(pairingReplyText(FRIDAY, "accept", { ok: true, status: "proposed" })).toBe("✅ Accepted for *Friday MT Community*. Waiting for MT Test's owner to accept too.");
    expect(pairingReplyText(FRIDAY, "accept", { ok: true, status: "active" })).toBe("✅ Accepted. *Friday MT Community* and *MT Test* are partner clubs now.");
  });

  it("declined", () => {
    expect(pairingReplyText(FRIDAY, "decline", { ok: true, status: "ended" })).toBe("Declined. *Friday MT Community* won't be paired with *MT Test*.");
  });

  it("an admin who is not the owner: the settings page's owner-only line", () => {
    expect(pairingReplyText(FRIDAY, "accept", { ok: false, refusal: "owner-only" })).toBe("Only your club's owner can accept, decline or remove a partner club.");
  });

  it("already accepted, or no longer waiting", () => {
    expect(pairingReplyText(FRIDAY, "accept", { ok: false, refusal: "already-accepted" })).toContain("already accepted");
    expect(pairingReplyText(FRIDAY, "decline", { ok: false, refusal: "not-proposed" })).toContain("isn't waiting for an answer");
    expect(pairingReplyText(FRIDAY, "accept", { ok: false, refusal: "ended" })).toContain("isn't waiting for an answer");
  });

  it("in Turkish", () => {
    const tr = { ...FRIDAY, lang: "tr" };
    expect(pairingReplyText(tr, "accept", { ok: true, status: "active" })).toBe("✅ Kabul edildi. *Friday MT Community* ve *MT Test* artık partner kulüp.");
    expect(pairingReplyText(tr, "decline", { ok: true, status: "ended" })).toBe("Reddedildi. *Friday MT Community*, *MT Test* ile eşleştirilmeyecek.");
    expect(pairingReplyText(tr, "accept", { ok: false, refusal: "owner-only" })).toContain("yalnızca kulübünüzün sahibi");
  });
});

describe("a reaction on the notice", () => {
  function reactionDeps(over: Partial<PairingReactionDeps> = {}) {
    return {
      notice: vi.fn(async () => ({ notice: TEST_SIDE, phone: "447700900001", userId: "kemal" })),
      act: vi.fn(async () => ({ outcome: "pairing-accept", reply: "Accepted." })),
      queueAck: vi.fn(async () => {}),
      ...over,
    } satisfies PairingReactionDeps;
  }

  it("not on a pairing notice: null, so the route carries on", async () => {
    const deps = reactionDeps({ notice: vi.fn(async () => null) });
    expect(await runPairingReaction({ waMessageId: "x", emoji: "✅", fromPhone: "447700900001" }, deps)).toBeNull();
  });

  it("✅ or 👍 by the person it was sent to accepts that notice's pairing for that club", async () => {
    for (const emoji of ["✅", "👍", "👍🏽"]) {
      const deps = reactionDeps();
      const r = await runPairingReaction({ waMessageId: "x", emoji, fromPhone: "+44 7700 900001" }, deps);
      expect(deps.act).toHaveBeenCalledWith(TEST_SIDE, "kemal", "accept");
      expect(deps.queueAck).toHaveBeenCalledWith({ orgId: "mttest", phone: "447700900001", text: "Accepted." });
      expect(r).toMatchObject({ handled: "pairing-reaction" });
    }
  });

  it("any other emoji does nothing", async () => {
    const deps = reactionDeps();
    expect(await runPairingReaction({ waMessageId: "x", emoji: "❤️", fromPhone: "447700900001" }, deps)).toEqual({ ok: true, ignored: "not-yes" });
    expect(deps.act).not.toHaveBeenCalled();
  });

  it("someone else's phone does nothing", async () => {
    const deps = reactionDeps();
    expect(await runPairingReaction({ waMessageId: "x", emoji: "✅", fromPhone: "447700900999" }, deps)).toEqual({ ok: true, ignored: "reactor-not-the-recipient" });
    expect(deps.act).not.toHaveBeenCalled();
  });
});
