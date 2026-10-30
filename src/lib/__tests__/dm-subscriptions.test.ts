/**
 * Unit tests for the PURE DM-subscription helpers in
 * src/lib/dm-subscriptions.ts.
 *
 * Since 2026-10-30 the message -> command step is the one DM reader's
 * (`dm-intent.ts`, stop_* and resume_* intents): the keyword parser these
 * tests used to pin is deleted. Its cases (the real incident message "do
 * not message me on any topic but payment" first) are now live cases in
 * `scripts/dryrun-dm-intent.ts` (SET=subs). What stays here is the
 * mapping from the read to the command, and the command to the flags.
 */
import { describe, it, expect } from "vitest";
import {
  subscriptionCommandOf,
  dmSubPatchForCommand,
  dmSubAckMessage,
  subRatingDmFromLegacy,
  DM_SUB_FIELDS,
} from "@/lib/dm-subscriptions";

describe("subscriptionCommandOf: the read's intent is the command", () => {
  it("each stop and resume intent maps to its command", () => {
    expect(subscriptionCommandOf("stop_messages")).toBe("opt-out-all");
    expect(subscriptionCommandOf("stop_ratings")).toBe("opt-out-ratings");
    expect(subscriptionCommandOf("resume_messages")).toBe("opt-in-all");
    expect(subscriptionCommandOf("resume_ratings")).toBe("opt-in-ratings");
  });
  it("every other intent is no command, so nothing is written", () => {
    for (const i of ["other", "question", "go_live", "recruit_blast", "partner_ask", "rating_progress", "intro_messages", "nonsense"]) {
      expect(subscriptionCommandOf(i)).toBeNull();
    }
  });
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
