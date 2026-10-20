/**
 * `featureForDueKey` is the scheduler's per-org feature gate, lifted out of
 * `computeDueInstructions` so the payment-claim classifier can say what a
 * scheduler DM was about (Feroz, FNF 2026-10-18: his pay chasers were
 * recorded only as SentNotification keys and never seen as "last
 * message"). One mapping, two readers.
 */
import { describe, it, expect } from "vitest";
import { featureForDueKey, topicOfDueKey } from "../due-key-feature";

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

/**
 * What a MatchTime DM was about, from its key (quoted-reply context, slice
 * S0, 2026-10-20). The feature map plus the tentative follow-up, whose key
 * the gate deliberately leaves unclassified. One definition, read by
 * the quoted-reply resolver and chat context (`reply-context.ts`).
 */
describe("topicOfDueKey", () => {
  it("is the key's feature when it has one", () => {
    expect(topicOfDueKey("m1:pay-chase:u1:2026-10-18")).toBe("paymentCollection");
    expect(topicOfDueKey("m1:rate-reminder:u1:2026-10-18")).toBe("playerRating");
  });

  it("the tentative follow-up is its own topic, though the gate leaves it unclassified", () => {
    expect(featureForDueKey("m1:tentative-followup:u1")).toBeNull();
    expect(topicOfDueKey("m1:tentative-followup:u1")).toBe("tentativeFollowup");
  });

  it("an ad-hoc or infrastructure key has no topic", () => {
    expect(topicOfDueKey("botjob-abc")).toBeNull();
    expect(topicOfDueKey("org-x:bot-intro")).toBeNull();
  });
});
