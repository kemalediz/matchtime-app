/**
 * Self-join slice 5: the connect DM's pure rules (plan 5.3 and cap 6).
 * No DB, no clock, no model.
 */
import { describe, expect, it } from "vitest";
import {
  ADD_WINDOW_MS,
  MAX_GROUP_LINKS_PER_DAY,
  MISMATCH_THROTTLE_MS,
  connectCodeCandidates,
  decideConnectDm,
  effectiveConnectStatus,
  lidDigits,
  maskPhoneForCard,
  type ConnectDmRow,
} from "../connect-dm-rules";
import { connectPrefill } from "../club-connect-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const MIN = 60_000;
const ORGANISER = "447700900123";
const STRANGER = "447700900999";

const row = (over: Partial<ConnectDmRow> = {}): ConnectDmRow => ({
  status: "issued",
  phone: ORGANISER,
  expiresAt: new Date(NOW.getTime() + 30 * MIN),
  addWindowEndsAt: null,
  dmLid: null,
  lastMismatchAt: null,
  orgApprovalStatus: "draft",
  ...over,
});

describe("reading the code", () => {
  it("reads the English and Turkish prefilled texts", () => {
    expect(connectCodeCandidates(connectPrefill("en", "Riverside FC", "7KQ2"))).toEqual(["7KQ2"]);
    expect(connectCodeCandidates(connectPrefill("tr", "Kartallar", "7KQ2"))).toEqual(["7KQ2"]);
    expect(connectCodeCandidates("Riverside FC kulübünü bağla, kod 7KQ2")).toEqual(["7KQ2"]);
  });

  it("is tolerant of case, spacing and punctuation", () => {
    for (const text of [
      "connect riverside fc, code 7kq2",
      "CONNECT RIVERSIDE FC, CODE 7KQ2",
      "Connect   Riverside FC ,   code    7KQ2  ",
      "Connect Riverside FC\ncode: 7KQ2",
      "code-7KQ2",
      "Code=7kq2!",
      "RIVERSIDE FC KULÜBÜNÜ BAĞLA, KOD 7KQ2",
      "kodu 7KQ2",
      "kodum: 7kq2",
    ]) {
      expect(connectCodeCandidates(text), text).toEqual(["7KQ2"]);
    }
  });

  it("does not care what the club name was edited to", () => {
    expect(connectCodeCandidates("Connect the Tuesday lads, code 7KQ2")).toEqual(["7KQ2"]);
    expect(connectCodeCandidates("please connect us! code 7KQ2 thanks")).toEqual(["7KQ2"]);
    expect(connectCodeCandidates("Salı ekibini bağla, kod 7KQ2")).toEqual(["7KQ2"]);
  });

  it("puts the LAST code-shaped token first, so a club called 'Kod Team' or 'Code FC' cannot win", () => {
    expect(connectCodeCandidates("Kod Team kulübünü bağla, kod 7KQ2")).toEqual(["7KQ2", "TEAM"]);
    expect(connectCodeCandidates("Connect Code FC, code 7KQ2")).toEqual(["7KQ2"]);
  });

  it("finds nothing without the word code or kod, or with a lookalike character", () => {
    for (const text of [
      "Connect Riverside FC",
      "7KQ2",
      "IN",
      "Paid",
      "code 7KO2", // O is not in the alphabet
      "code 7K02", // nor 0
      "code 1KQ2", // nor 1
      "code 7KQI", // nor I
      "code 7KQL", // nor L
      "code 7KQ22", // five characters is not a code
      "barcode 7KQ2", // "code" must stand alone
      "",
    ]) {
      expect(connectCodeCandidates(text), text).toEqual([]);
    }
    expect(connectCodeCandidates(null)).toEqual([]);
    expect(connectCodeCandidates("x".repeat(600) + " code 7KQ2")).toEqual([]);
  });
});

describe("identities off the envelope", () => {
  it("a LID as bare digits", () => {
    expect(lidDigits("123456789012345@lid")).toBe("123456789012345");
    expect(lidDigits("123456789012345:7@lid")).toBe("123456789012345");
    expect(lidDigits("123456789012345")).toBe("123456789012345");
    expect(lidDigits("447700900123@c.us")).toBeNull();
    expect(lidDigits("")).toBeNull();
    expect(lidDigits(undefined)).toBeNull();
  });

  it("masks the other number the way the card shows it", () => {
    expect(maskPhoneForCard("447700900123")).toBe("+44 77** ***123");
    expect(maskPhoneForCard("905321234567")).toBe("+90 53** ***567");
    expect(maskPhoneForCard("14155550123")).toBe("+141** ***123");
    expect(maskPhoneForCard("447700900123")).not.toContain("900");
  });
});

describe("what the DM does (plan 5.3)", () => {
  const organiser = { phones: [ORGANISER], lid: "111111111" };

  it("issued, from the sign-up phone: verify", () => {
    expect(decideConnectDm({ row: row(), sender: organiser, now: NOW, linksToday: 0 })).toEqual({
      action: "verify",
      dmPhone: ORGANISER,
      dmPhoneMatched: true,
    });
  });

  it("issued, phone hidden but a LID present: verify bound to the LID, phone not confirmed", () => {
    expect(decideConnectDm({ row: row(), sender: { phones: [], lid: "111111111" }, now: NOW, linksToday: 0 })).toEqual({
      action: "verify",
      dmPhone: null,
      dmPhoneMatched: null,
    });
  });

  it("issued, from another number: record it (masked), never reply", () => {
    expect(decideConnectDm({ row: row(), sender: { phones: [STRANGER], lid: null }, now: NOW, linksToday: 0 })).toEqual({
      action: "mismatch",
      masked: "+44 77** ***999",
    });
  });

  it("mismatches are throttled: once a minute per code", () => {
    const recent = row({ lastMismatchAt: new Date(NOW.getTime() - MISMATCH_THROTTLE_MS + 1000) });
    expect(decideConnectDm({ row: recent, sender: { phones: [STRANGER], lid: null }, now: NOW, linksToday: 0 })).toEqual({
      action: "ignore",
      reason: "mismatch-throttled",
    });
    const older = row({ lastMismatchAt: new Date(NOW.getTime() - MISMATCH_THROTTLE_MS) });
    expect(decideConnectDm({ row: older, sender: { phones: [STRANGER], lid: null }, now: NOW, linksToday: 0 }).action).toBe(
      "mismatch",
    );
  });

  it("a mismatch never counts toward, or is blocked by, the site cap", () => {
    expect(
      decideConnectDm({ row: row(), sender: { phones: [STRANGER], lid: null }, now: NOW, linksToday: MAX_GROUP_LINKS_PER_DAY })
        .action,
    ).toBe("mismatch");
  });

  it("no phone and no LID: silent", () => {
    expect(decideConnectDm({ row: row(), sender: { phones: [], lid: null }, now: NOW, linksToday: 0 })).toEqual({
      action: "ignore",
      reason: "no-sender-identity",
    });
  });

  it("cap 6: five links a day across the site; the sixth organiser hears the cap line", () => {
    expect(MAX_GROUP_LINKS_PER_DAY).toBe(5);
    expect(decideConnectDm({ row: row(), sender: organiser, now: NOW, linksToday: 4 }).action).toBe("verify");
    expect(decideConnectDm({ row: row(), sender: organiser, now: NOW, linksToday: 5 })).toEqual({ action: "site-cap" });
  });

  it("issued but the club is no longer a draft: silent", () => {
    expect(decideConnectDm({ row: row({ orgApprovalStatus: "pending" }), sender: organiser, now: NOW, linksToday: 0 })).toEqual({
      action: "ignore",
      reason: "club-not-draft",
    });
  });

  it("expired (past 60 minutes) or superseded, from the organiser: one 'expired' reply", () => {
    const stale = row({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(decideConnectDm({ row: stale, sender: organiser, now: NOW, linksToday: 0 })).toEqual({
      action: "reply",
      reply: "expired",
    });
    expect(decideConnectDm({ row: row({ status: "superseded" }), sender: organiser, now: NOW, linksToday: 0 })).toEqual({
      action: "reply",
      reply: "expired",
    });
    expect(decideConnectDm({ row: row({ status: "expired" }), sender: organiser, now: NOW, linksToday: 0 }).action).toBe("reply");
  });

  it("expired, from anyone else: silent (MatchTime only messages the sign-up number)", () => {
    expect(
      decideConnectDm({ row: row({ status: "expired" }), sender: { phones: [STRANGER], lid: null }, now: NOW, linksToday: 0 }),
    ).toEqual({ action: "ignore", reason: "code-expired" });
    expect(decideConnectDm({ row: row({ status: "expired" }), sender: { phones: [], lid: "1234567" }, now: NOW, linksToday: 0 }).action).toBe(
      "ignore",
    );
  });

  it("already DM-verified, same sender (phone, or LID when the phone is hidden): 'already connected'", () => {
    const verified = row({ status: "dm_verified", addWindowEndsAt: new Date(NOW.getTime() + ADD_WINDOW_MS), dmLid: "111111111" });
    expect(decideConnectDm({ row: verified, sender: organiser, now: NOW, linksToday: 9 })).toEqual({
      action: "reply",
      reply: "already-connected",
    });
    expect(decideConnectDm({ row: verified, sender: { phones: [], lid: "111111111" }, now: NOW, linksToday: 0 }).action).toBe(
      "reply",
    );
    expect(decideConnectDm({ row: verified, sender: { phones: [STRANGER], lid: "111111111" }, now: NOW, linksToday: 0 })).toEqual({
      action: "ignore",
      reason: "verified-by-another-sender",
    });
  });

  it("DM-verified past the 24-hour add window counts as expired", () => {
    const lapsed = row({ status: "dm_verified", addWindowEndsAt: new Date(NOW.getTime() - 1) });
    expect(effectiveConnectStatus(lapsed, NOW)).toBe("expired");
    expect(decideConnectDm({ row: lapsed, sender: organiser, now: NOW, linksToday: 0 })).toEqual({ action: "reply", reply: "expired" });
  });

  it("a code already used for a group (group_linked, closed): silent", () => {
    for (const status of ["group_linked", "closed"]) {
      expect(decideConnectDm({ row: row({ status }), sender: organiser, now: NOW, linksToday: 0 })).toEqual({
        action: "ignore",
        reason: `code-${status}`,
      });
    }
  });
});
