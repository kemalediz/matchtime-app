/**
 * Confirming a /play sign-up on WhatsApp: the pure rules (slice L2).
 * Reading the code is a token lookup (the connect DM's own reader, reused);
 * the words matter only for whether a code that names nothing is answered.
 */
import { describe, expect, it } from "vitest";
import { CONNECT_CODE_ALPHABET } from "../../club-connect-rules";
import {
  attemptPurgeBefore,
  codeReplyAllowed,
  confirmWindowStart,
  decidePoolConfirm,
  generatePoolConfirmCode,
  looksLikePoolConfirm,
  poolCodeCandidates,
  poolCodeExpiry,
  poolConfirmPrefill,
  readPoolConfirmMessage,
} from "../confirm-rules";
import { POOL_CONFIRM, POOL_CONFIRM_CODE_ALPHABET, POOL_RETENTION } from "../rules";

const NOW = new Date("2026-10-24T12:00:00Z");
const mins = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe("the code", () => {
  it("uses the pool alphabet, which is the connect code's (one way to read both)", () => {
    expect(POOL_CONFIRM_CODE_ALPHABET).toBe(CONNECT_CODE_ALPHABET);
    let i = 0;
    expect(generatePoolConfirmCode(() => i++ % 31)).toBe("ABCD");
    for (let n = 0; n < 50; n++) expect(generatePoolConfirmCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it("lives as long as a waiting sign-up does", () => {
    expect(POOL_CONFIRM.codeTtlDays).toBe(POOL_RETENTION.pendingExpiryDays);
    expect(poolCodeExpiry(NOW).getTime() - NOW.getTime()).toBe(7 * 24 * 3600_000);
  });

  it("is carried in the prefilled message in English and Turkish", () => {
    expect(poolConfirmPrefill("en", "K7QP")).toBe("Hi MatchTime, sign me up to play. Code K7QP");
    expect(poolConfirmPrefill("tr", "K7QP")).toBe("Merhaba MatchTime, oynamak için kaydet. Kod K7QP");
    expect(poolCodeCandidates(poolConfirmPrefill("en", "K7QP"))).toEqual(["K7QP"]);
    expect(poolCodeCandidates(poolConfirmPrefill("tr", "K7QP"))).toEqual(["K7QP"]);
  });

  it("is found whatever surrounds it, in any case", () => {
    expect(poolCodeCandidates("ok here it is: code k7qp thanks")).toEqual(["K7QP"]);
    expect(poolCodeCandidates("kodum: K7QP")).toEqual(["K7QP"]);
  });

  it("is never read out of the self-join connect message, which is that handler's", () => {
    expect(poolCodeCandidates("Connect Riverside FC, code 7KQ2")).toEqual([]);
    expect(poolCodeCandidates("Riverside FC kulübünü bağla, kod 7KQ2")).toEqual([]);
  });

  it("is nothing in a message without a code", () => {
    expect(poolCodeCandidates("can I play football with you lot?")).toEqual([]);
    expect(poolCodeCandidates("IN (ref K7Q2)")).toEqual([]);
  });
});

describe("does it read like our confirm message?", () => {
  it("our prefill in either language, edited only in case, spacing or punctuation", () => {
    expect(looksLikePoolConfirm("Hi MatchTime, sign me up to play. Code K7QP")).toBe(true);
    expect(looksLikePoolConfirm("hi matchtime sign me up to play code zzzz")).toBe(true);
    expect(looksLikePoolConfirm("Merhaba MatchTime, oynamak için kaydet. Kod K7QP")).toBe(true);
    expect(looksLikePoolConfirm("MERHABA MATCHTIME OYNAMAK ICIN KAYDET KOD K7QP")).toBe(true);
  });

  it("says which language it is in", () => {
    expect(readPoolConfirmMessage("Hi MatchTime, sign me up to play. Code K7QP")).toEqual({ lang: "en" });
    expect(readPoolConfirmMessage("Merhaba MatchTime, oynamak için kaydet. Kod K7QP")).toEqual({ lang: "tr" });
    expect(readPoolConfirmMessage("kod K7QP")).toEqual({ lang: "tr" });
    expect(readPoolConfirmMessage("can I play")).toBeNull();
  });

  it("the code phrase alone", () => {
    expect(looksLikePoolConfirm("Code K7QP")).toBe(true);
    expect(looksLikePoolConfirm("kod: K7QP")).toBe(true);
  });

  it("not chat that happens to contain a code-shaped word", () => {
    expect(looksLikePoolConfirm("what's the code then")).toBe(false);
    expect(looksLikePoolConfirm("the door code is 7KQ2 btw")).toBe(false);
    expect(looksLikePoolConfirm("can I play?")).toBe(false);
    expect(looksLikePoolConfirm("Connect Riverside FC, code 7KQ2")).toBe(false);
  });
});

describe("what a DM with a code does", () => {
  const base = { hasPhone: true, sender: null, failuresToday: 0, looksLikeConfirm: true, now: NOW };
  const live = { expiresAt: new Date(NOW.getTime() + 3600_000) };

  it("a live code from a new number confirms", () => {
    expect(decidePoolConfirm({ ...base, row: live })).toEqual({ action: "confirm" });
  });

  it("a live code from someone whose profile is stopped confirms too (a fresh consent)", () => {
    expect(decidePoolConfirm({ ...base, row: live, sender: { status: "stopped" } })).toEqual({ action: "confirm" });
  });

  it("a live code from someone already in the pool keeps his profile and tells him how to change it", () => {
    expect(decidePoolConfirm({ ...base, row: live, sender: { status: "active" } })).toEqual({ action: "already-signed-up" });
    expect(decidePoolConfirm({ ...base, row: live, sender: { status: "paused" } })).toEqual({ action: "already-signed-up" });
  });

  it("an expired code fails with the expired reply", () => {
    expect(decidePoolConfirm({ ...base, row: { expiresAt: NOW } })).toEqual({ action: "failed", reply: "expired" });
  });

  it("an unknown code in our message fails with the wrong-code reply", () => {
    expect(decidePoolConfirm({ ...base, row: null })).toEqual({ action: "failed", reply: "wrong-code" });
  });

  it("an unknown code in other words is not the pool's", () => {
    expect(decidePoolConfirm({ ...base, row: null, looksLikeConfirm: false })).toEqual({ action: "pass" });
  });

  it("an already-confirmed person sending his message again is welcomed once, never told it failed", () => {
    expect(decidePoolConfirm({ ...base, row: null, sender: { status: "active" } })).toEqual({ action: "ignore", reason: "already-in-pool" });
  });

  it("a number that guessed too many codes today has every code ignored, a right one too", () => {
    const locked = { ...base, failuresToday: POOL_CONFIRM.wrongCodesPerDay };
    expect(decidePoolConfirm({ ...locked, row: live })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...locked, row: null })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...base, failuresToday: POOL_CONFIRM.wrongCodesPerDay - 1, row: live })).toEqual({ action: "confirm" });
  });

  it("a LID with no phone can be neither recorded nor answered", () => {
    expect(decidePoolConfirm({ ...base, hasPhone: false, row: live })).toEqual({ action: "ignore", reason: "no-phone" });
    expect(decidePoolConfirm({ ...base, hasPhone: false, row: null })).toEqual({ action: "ignore", reason: "no-phone" });
  });
});

describe("the 'that code did not work' reply is rate-limited", () => {
  it("the first one goes", () => {
    expect(codeReplyAllowed([], NOW)).toBe(true);
  });

  it("not again within the throttle", () => {
    expect(codeReplyAllowed([mins(POOL_CONFIRM.replyThrottleMins - 1)], NOW)).toBe(false);
    expect(codeReplyAllowed([mins(POOL_CONFIRM.replyThrottleMins)], NOW)).toBe(true);
  });

  it("at most repliesPerDay in 24 hours", () => {
    const sent = Array.from({ length: POOL_CONFIRM.repliesPerDay }, (_, i) => mins(60 * (i + 1)));
    expect(codeReplyAllowed(sent, NOW)).toBe(false);
    expect(codeReplyAllowed(sent.slice(1), NOW)).toBe(true);
    expect(codeReplyAllowed([mins(25 * 60), mins(26 * 60), mins(27 * 60)], NOW)).toBe(true);
  });

  it("the windows", () => {
    expect(NOW.getTime() - confirmWindowStart(NOW).getTime()).toBe(24 * 3600_000);
    expect(NOW.getTime() - attemptPurgeBefore(NOW).getTime()).toBe(POOL_CONFIRM.attemptKeepDays * 24 * 3600_000);
  });
});
