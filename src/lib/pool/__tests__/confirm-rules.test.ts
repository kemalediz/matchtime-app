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
import { POOL_CONFIRM, POOL_CONFIRM_CODE_ALPHABET, POOL_CONFIRM_CODE_LENGTH, POOL_RETENTION } from "../rules";
import { connectCodeCandidates } from "../../connect-dm-rules";

const NOW = new Date("2026-10-24T12:00:00Z");
const mins = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe("the code", () => {
  it("uses the pool alphabet, which is the connect code's (one way to read both)", () => {
    expect(POOL_CONFIRM_CODE_ALPHABET).toBe(CONNECT_CODE_ALPHABET);
    let i = 0;
    expect(generatePoolConfirmCode(() => i++ % 31)).toBe("ABCDE");
    for (let n = 0; n < 50; n++) expect(generatePoolConfirmCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  });

  it("is 5 characters, so it can never be read as a 4-character self-join connect code, and the other way round", () => {
    expect(POOL_CONFIRM_CODE_LENGTH).toBe(5);
    expect(connectCodeCandidates(poolConfirmPrefill("en", "K7QP2"))).toEqual([]);
    expect(connectCodeCandidates(poolConfirmPrefill("tr", "K7QP2"))).toEqual([]);
    for (const bare of ["Code 7KQ2", "code: 7KQ2", "Kod 7KQ2", "kodu 7KQ2", "kodum 7KQ2"]) {
      expect(connectCodeCandidates(bare), bare).toEqual(["7KQ2"]);
      expect(poolCodeCandidates(bare), bare).toEqual([]);
      expect(readPoolConfirmMessage(bare), bare).toBeNull();
    }
  });

  it("expires before the waiting sign-up is deleted, so a late message hears 'expired' for a while", () => {
    expect(POOL_CONFIRM.codeTtlDays).toBeLessThan(POOL_RETENTION.pendingExpiryDays);
    expect(poolCodeExpiry(NOW).getTime() - NOW.getTime()).toBe(POOL_CONFIRM.codeTtlDays * 24 * 3600_000);
  });

  it("is carried in the prefilled message in English and Turkish", () => {
    expect(poolConfirmPrefill("en", "K7QP2")).toBe("Hi MatchTime, sign me up to play. Code K7QP2");
    expect(poolConfirmPrefill("tr", "K7QP2")).toBe("Merhaba MatchTime, oynamak için kaydet. Kod K7QP2");
    expect(poolCodeCandidates(poolConfirmPrefill("en", "K7QP2"))).toEqual(["K7QP2"]);
    expect(poolCodeCandidates(poolConfirmPrefill("tr", "K7QP2"))).toEqual(["K7QP2"]);
  });

  it("is found whatever surrounds it, in any case", () => {
    expect(poolCodeCandidates("ok here it is: code k7qp2 thanks")).toEqual(["K7QP2"]);
    expect(poolCodeCandidates("kodum: K7QP2")).toEqual(["K7QP2"]);
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
    expect(looksLikePoolConfirm("Hi MatchTime, sign me up to play. Code K7QP2")).toBe(true);
    expect(looksLikePoolConfirm("hi matchtime sign me up to play code zzzzz")).toBe(true);
    expect(looksLikePoolConfirm("Merhaba MatchTime, oynamak için kaydet. Kod K7QP2")).toBe(true);
    expect(looksLikePoolConfirm("MERHABA MATCHTIME OYNAMAK ICIN KAYDET KOD K7QP2")).toBe(true);
  });

  it("says which language it is in", () => {
    expect(readPoolConfirmMessage("Hi MatchTime, sign me up to play. Code K7QP2")).toEqual({ lang: "en" });
    expect(readPoolConfirmMessage("Merhaba MatchTime, oynamak için kaydet. Kod K7QP2")).toEqual({ lang: "tr" });
    expect(readPoolConfirmMessage("kod K7QP2")).toEqual({ lang: "tr" });
    expect(readPoolConfirmMessage("can I play")).toBeNull();
  });

  it("the code phrase alone", () => {
    expect(looksLikePoolConfirm("Code K7QP2")).toBe(true);
    expect(looksLikePoolConfirm("kod: K7QP2")).toBe(true);
  });

  it("not chat that happens to contain a code-shaped word", () => {
    expect(looksLikePoolConfirm("what's the code then")).toBe(false);
    expect(looksLikePoolConfirm("the door code is 7KQ2 btw")).toBe(false);
    expect(looksLikePoolConfirm("can I play?")).toBe(false);
    expect(looksLikePoolConfirm("Connect Riverside FC, code 7KQ2")).toBe(false);
  });
});

describe("what a DM with a code does", () => {
  const base = { hasPhone: true, sender: null, ownCode: false, failuresToday: 0, looksLikeConfirm: true, now: NOW };
  const live = { expiresAt: new Date(NOW.getTime() + 3600_000) };

  it("a live code from a number with no profile confirms (the first number to send it verifies)", () => {
    expect(decidePoolConfirm({ ...base, row: live })).toEqual({ action: "confirm" });
  });

  it("a live code from a number that already has a profile, of ANY status, never attaches it: a clear message, and it counts", () => {
    for (const status of ["active", "paused", "stopped"] as const) {
      expect(decidePoolConfirm({ ...base, row: live, sender: { status } })).toEqual({ action: "already-signed-up", status });
    }
  });

  it("an expired code fails with the expired reply", () => {
    expect(decidePoolConfirm({ ...base, row: { expiresAt: NOW } })).toEqual({ action: "failed", reply: "expired" });
  });

  it("an unknown code in our message fails with the wrong-code reply, for strangers AND for people in the pool", () => {
    expect(decidePoolConfirm({ ...base, row: null })).toEqual({ action: "failed", reply: "wrong-code" });
    expect(decidePoolConfirm({ ...base, row: null, sender: { status: "active" } })).toEqual({ action: "failed", reply: "wrong-code" });
  });

  it("an unknown code in other words is not the pool's", () => {
    expect(decidePoolConfirm({ ...base, row: null, looksLikeConfirm: false })).toEqual({ action: "pass" });
  });

  it("his OWN spent code again (he sent his message twice) is silent and not counted: he was welcomed once", () => {
    expect(decidePoolConfirm({ ...base, row: null, sender: { status: "active" }, ownCode: true })).toEqual({ action: "ignore", reason: "already-in-pool" });
  });

  it("the lock comes first, for everybody: strangers, members, a right code, a wrong one", () => {
    const locked = { ...base, failuresToday: POOL_CONFIRM.wrongCodesPerDay };
    expect(decidePoolConfirm({ ...locked, row: live })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...locked, row: null })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...locked, row: null, sender: { status: "active" } })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...locked, row: live, sender: { status: "stopped" } })).toEqual({ action: "ignore", reason: "locked" });
    expect(decidePoolConfirm({ ...base, failuresToday: POOL_CONFIRM.wrongCodesPerDay - 1, row: live })).toEqual({ action: "confirm" });
  });

  it("a member's code from another account's number: refused with the neutral line, and it counts (slice L3)", () => {
    expect(decidePoolConfirm({ ...base, row: live, notYours: true })).toEqual({ action: "failed", reply: "not-yours" });
    expect(decidePoolConfirm({ ...base, row: live, notYours: true, sender: { status: "active" } })).toEqual({ action: "failed", reply: "not-yours" });
    expect(decidePoolConfirm({ ...base, failuresToday: POOL_CONFIRM.wrongCodesPerDay, row: live, notYours: true })).toEqual({ action: "ignore", reason: "locked" });
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

// Slice L3 (manager review of #401): a number is never put on a member's
// account silently. A code he started from his profile, sent from a number
// no account holds, waits for HIS yes on the signed-in page.
import { confirmTarget } from "../confirm-rules";

describe("whose profile a confirmed code becomes", () => {
  it("a stranger's /play sign-up: the number's own account (accounts are never merged)", () => {
    expect(confirmTarget({ numberUserId: "u-num", starterId: null })).toEqual({ kind: "number-account", userId: "u-num" });
  });
  it("a member's sign-up only ever ends on HIS account: his own number confirms it", () => {
    expect(confirmTarget({ numberUserId: "u-member", starterId: "u-member" })).toEqual({ kind: "number-account", userId: "u-member" });
  });
  it("a member's sign-up sent from a number of ANOTHER account: nothing attached (his name, pitches and hours never reach that account)", () => {
    expect(confirmTarget({ numberUserId: "u-other", starterId: "u-member" })).toEqual({ kind: "not-yours" });
  });
  it("a number no account holds, on a member's code: his claim to answer, nothing attached", () => {
    expect(confirmTarget({ numberUserId: null, starterId: "u-member" })).toEqual({ kind: "member-claim", starterId: "u-member" });
  });
  it("a number no account holds, on a stranger's /play code: a new account, as before", () => {
    expect(confirmTarget({ numberUserId: null, starterId: null })).toEqual({ kind: "new-account" });
  });
});
