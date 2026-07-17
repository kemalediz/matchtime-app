/**
 * Unit tests for the PURE DM-subscription command parser + helpers in
 * src/lib/dm-subscriptions.ts.
 *
 * These pin the message -> intent mapping the DM fast-path relies on
 * (src/app/api/whatsapp/dm-reply/route.ts). No DB, no network — the parser
 * is deliberately a pure function so the disambiguation can be tested
 * exhaustively and deterministically (no LLM in this path).
 *
 * The load-bearing case is the real incident message:
 *   "do not message me on any topic but payment"
 * which MUST classify as the BROAD all-but-payment opt-out, NOT the
 * narrow ratings-only opt-out (the old bug that made the bot lie).
 */
import { describe, it, expect } from "vitest";
import {
  parseDmSubscriptionCommand,
  dmSubPatchForCommand,
  dmSubAckMessage,
  subRatingDmFromLegacy,
  DM_SUB_FIELDS,
} from "@/lib/dm-subscriptions";

describe("parseDmSubscriptionCommand — BROAD all-but-payment opt-out", () => {
  const broad = [
    "do not message me on any topic but payment", // the real incident message
    "only message me about payment",
    "don't message me except about payment",
    "nothing but payment",
    "only payment please",
    "just payment",
    "leave me alone except payment",
    "only payments from now on",
    "please only contact me about payment",
  ];
  for (const msg of broad) {
    it(`"${msg}" -> opt-out-all`, () => {
      expect(parseDmSubscriptionCommand(msg)).toBe("opt-out-all");
    });
  }

  it("a bare broad 'stop messaging me' (no category) -> opt-out-all", () => {
    expect(parseDmSubscriptionCommand("stop messaging me")).toBe("opt-out-all");
    expect(parseDmSubscriptionCommand("please stop messaging me")).toBe("opt-out-all");
    expect(parseDmSubscriptionCommand("leave me alone")).toBe("opt-out-all");
    expect(parseDmSubscriptionCommand("stop")).toBe("opt-out-all");
  });
});

describe("parseDmSubscriptionCommand — narrow ratings-only opt-out (preserved)", () => {
  const ratings = [
    "stop messaging me about ratings",
    "no more rating messages",
    "stop the mom prompts",
    "don't message me about man of the match",
    "unsubscribe from rating reminders",
  ];
  for (const msg of ratings) {
    it(`"${msg}" -> opt-out-ratings`, () => {
      expect(parseDmSubscriptionCommand(msg)).toBe("opt-out-ratings");
    });
  }
});

describe("parseDmSubscriptionCommand — opt back in", () => {
  it("'start messages' -> opt-in-all", () => {
    expect(parseDmSubscriptionCommand("start messages")).toBe("opt-in-all");
  });
  it("'resume' / 'opt in' -> opt-in-all", () => {
    expect(parseDmSubscriptionCommand("resume")).toBe("opt-in-all");
    expect(parseDmSubscriptionCommand("opt in")).toBe("opt-in-all");
    expect(parseDmSubscriptionCommand("opt-in")).toBe("opt-in-all");
  });
  it("'start ratings' -> opt-in-ratings", () => {
    expect(parseDmSubscriptionCommand("start ratings")).toBe("opt-in-ratings");
  });
  it("'start rating messages again' -> opt-in-ratings", () => {
    expect(parseDmSubscriptionCommand("start rating messages again")).toBe("opt-in-ratings");
  });
});

describe("parseDmSubscriptionCommand — ordinary chat falls through (null)", () => {
  const chat = [
    "what time is kickoff?",
    "I'm in for tonight",
    "cheers mate",
    "can you start the match at 8?",
    "no problem, see you there",
    "great game lads",
    "how much do I owe for payment?",
  ];
  for (const msg of chat) {
    it(`"${msg}" -> null`, () => {
      expect(parseDmSubscriptionCommand(msg)).toBeNull();
    });
  }
});

describe("dmSubPatchForCommand", () => {
  it("opt-out-all sets EVERY sub flag false (payment has no flag)", () => {
    const patch = dmSubPatchForCommand("opt-out-all");
    for (const f of DM_SUB_FIELDS) expect(patch[f]).toBe(false);
    expect(Object.keys(patch).sort()).toEqual([...DM_SUB_FIELDS].sort());
  });
  it("opt-in-all sets EVERY sub flag true", () => {
    const patch = dmSubPatchForCommand("opt-in-all");
    for (const f of DM_SUB_FIELDS) expect(patch[f]).toBe(true);
  });
  it("opt-out-ratings touches ONLY subRatingDm=false", () => {
    expect(dmSubPatchForCommand("opt-out-ratings")).toEqual({ subRatingDm: false });
  });
  it("opt-in-ratings touches ONLY subRatingDm=true", () => {
    expect(dmSubPatchForCommand("opt-in-ratings")).toEqual({ subRatingDm: true });
  });
});

describe("dmSubAckMessage", () => {
  it("all-but-payment ack promises payment-only + how to undo", () => {
    const m = dmSubAckMessage("opt-out-all");
    expect(m.toLowerCase()).toContain("payment");
    expect(m.toLowerCase()).toContain("start messages");
  });
  it("ratings ack mentions rating / man-of-the-match", () => {
    expect(dmSubAckMessage("opt-out-ratings").toLowerCase()).toMatch(/rating|man-of-the-match|man of the match/);
  });
});

describe("subRatingDmFromLegacy — data-migration backfill logic", () => {
  it("ratingDmOptOut=true  => subRatingDm=false (opt-out preserved)", () => {
    expect(subRatingDmFromLegacy(true)).toBe(false);
  });
  it("ratingDmOptOut=false => subRatingDm=true (still subscribed)", () => {
    expect(subRatingDmFromLegacy(false)).toBe(true);
  });
});
