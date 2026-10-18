/**
 * `featureForDueKey` is the scheduler's per-org feature gate, lifted out of
 * `computeDueInstructions` so the payment-claim classifier can say what a
 * scheduler DM was about (Feroz, FNF 2026-10-18: his pay chasers were
 * recorded only as SentNotification keys and never seen as "last
 * message"). One mapping, two readers.
 */
import { describe, it, expect } from "vitest";
import { featureForDueKey } from "../due-key-feature";

describe("featureForDueKey", () => {
  it.each([
    ["m1:pay-chase:u1:2026-10-18", "paymentCollection"],
    ["m1:fee-ask:2026-10-18", "paymentCollection"],
    ["m1:unpaid-reminder", "paymentTracking"],
    ["m1:rate-reminder:u1:2026-10-18", "playerRating"],
    ["m1:rate-dm:u1", "playerRating"],
    ["m1:mom-vote", "momVoting"],
    ["m1:announce-match", "attendance"],
    ["m1:recruit-chase:u1", "attendance"],
    ["m1:bench-prompt:u1", "bench"],
    ["m1:ask-score", "teamBalancing"],
    ["m1:badges", "badgeAnnouncements"],
  ])("%s -> %s", (key, feature) => {
    expect(featureForDueKey(key)).toBe(feature);
  });

  it("an infrastructure key is not classified (always allowed)", () => {
    expect(featureForDueKey("org-x:bot-intro")).toBeNull();
    expect(featureForDueKey("retro-reaction:abc")).toBeNull();
  });
});
