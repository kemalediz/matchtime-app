/**
 * Growth slice G1: share links, campaign codes and the attribution rules.
 * PURE: no database, no clock, no model.
 */
import { describe, expect, it } from "vitest";
import { POOL_CAMPAIGN_SOURCES } from "../vocab";
import { POOL_CONFIRM_CODE_ALPHABET, POOL_CONFIRM_CODE_LENGTH } from "../rules";
import { readSignupSource } from "../profile-fields";
import {
  POOL_ATTRIBUTION,
  POOL_CAMPAIGN_CODE_MAX,
  POOL_CAMPAIGN_LABEL_MAX,
  POOL_CAMPAIGN_OWNER_SOURCES,
  POOL_SHARE_CODE_LENGTH,
  campaignSignupCounts,
  generatePoolShareCode,
  poolCampaignUrl,
  poolShareMessage,
  poolShareUrl,
  poolShareWhatsAppLink,
  referralCountsForReward,
  referrerShownName,
  settleReferral,
  shareCardShown,
  validateCampaignInput,
} from "../growth-rules";

const BASE = "https://matchtime.test";

describe("the personal share code", () => {
  it("is 6 characters from the pool's unambiguous alphabet, so it is never read as a 5-character confirm code", () => {
    expect(POOL_SHARE_CODE_LENGTH).toBe(6);
    expect(POOL_SHARE_CODE_LENGTH).not.toBe(POOL_CONFIRM_CODE_LENGTH);
    for (let i = 0; i < 200; i++) {
      const code = generatePoolShareCode();
      expect(code).toHaveLength(6);
      expect([...code].every((ch) => POOL_CONFIRM_CODE_ALPHABET.includes(ch))).toBe(true);
    }
  });

  it("takes an injectable random source", () => {
    expect(generatePoolShareCode(() => 0)).toBe(POOL_CONFIRM_CODE_ALPHABET[0].repeat(6));
  });

  it("is a code /play accepts as ?ref=", () => {
    const code = generatePoolShareCode();
    expect(readSignupSource({ ref: code })).toEqual({ campaignCode: null, referralCode: code });
  });
});

describe("the links", () => {
  it("a share link is /play?ref=CODE on the app's host", () => {
    expect(poolShareUrl(BASE, "K7QP2M")).toBe("https://matchtime.test/play?ref=K7QP2M");
    expect(poolShareUrl(`${BASE}/`, "K7QP2M")).toBe("https://matchtime.test/play?ref=K7QP2M");
  });

  it("a campaign link is /play?src=CODE, and /play reads ?src= (and the older ?c=) as the campaign", () => {
    expect(poolCampaignUrl(BASE, "li-kemal")).toBe("https://matchtime.test/play?src=li-kemal");
    expect(readSignupSource({ src: "li-kemal" })).toEqual({ campaignCode: "li-kemal", referralCode: null });
    expect(readSignupSource({ c: "li-kemal" })).toEqual({ campaignCode: "li-kemal", referralCode: null });
    expect(readSignupSource({ src: "Bad Code!" })).toEqual({ campaignCode: null, referralCode: null });
  });
});

describe("the ready-to-forward message", () => {
  const url = poolShareUrl(BASE, "K7QP2M");

  it("English: natural, ends with the link, nothing else of his in it", () => {
    const m = poolShareMessage("en", url);
    expect(m).toBe(`I get local games through MatchTime, and it does player ratings and Man of the Match too. Sign up here and they'll message you on WhatsApp when a team near you needs a player: ${url}`);
  });

  it("Turkish", () => {
    const m = poolShareMessage("tr", url);
    expect(m).toBe(`Yakındaki maçlar için MatchTime kullanıyorum; oyuncu puanları ve maçın adamı seçimi de var. Sen de kaydol, yakınında bir takıma oyuncu lazım olunca sana WhatsApp'tan yazsınlar: ${url}`);
  });

  it("the WhatsApp button opens a chat picker with the message, never a number (reuses waMeLink)", () => {
    const link = poolShareWhatsAppLink("en", url);
    expect(link).toBe(`https://wa.me/?text=${encodeURIComponent(poolShareMessage("en", url))}`);
    expect(link).not.toMatch(/wa\.me\/\d/);
  });

  it("no dashes, never a waiting list, and Turkish is not English", () => {
    for (const lang of ["en", "tr"] as const) {
      const m = poolShareMessage(lang, url);
      expect(m).not.toMatch(/[—–]/);
      expect(m).not.toMatch(/waiting list|bekleme listesi/i);
    }
    expect(poolShareMessage("tr", url)).not.toBe(poolShareMessage("en", url));
  });
});

describe("the share card", () => {
  it("is shown to a live profile (active or paused), never to a stopped or waiting one", () => {
    expect(shareCardShown("active")).toBe(true);
    expect(shareCardShown("paused")).toBe(true);
    expect(shareCardShown("stopped")).toBe(false);
    expect(shareCardShown("pending-verify")).toBe(false);
  });
});

describe("the referrer's name on /play and on the card", () => {
  it("first name and last initial, only while his privacy switch shows it", () => {
    expect(referrerShownName({ displayName: "Ali Kaya", showRecognition: true })).toBe("Ali K.");
    expect(referrerShownName({ displayName: "Ali K", showRecognition: true })).toBe("Ali K.");
    expect(referrerShownName({ displayName: "Ali", showRecognition: true })).toBe("Ali");
    expect(referrerShownName({ displayName: "Ali Kaya", showRecognition: false })).toBeNull();
    expect(referrerShownName(null)).toBeNull();
    expect(referrerShownName({ displayName: "   ", showRecognition: true })).toBeNull();
  });
});

describe("campaign codes on the owner page", () => {
  it("accepts lowercase letters, digits and single hyphens, a known source and a label", () => {
    expect(validateCampaignInput({ code: " LinkedIn-Kemal ", source: "linkedin", label: " Kemal's LinkedIn post " })).toEqual({
      ok: true,
      value: { code: "linkedin-kemal", source: "linkedin", label: "Kemal's LinkedIn post" },
    });
    expect(validateCampaignInput({ code: "leaflet-sutton-oct", source: "leaflet", label: "Sutton leaflets, October" }).ok).toBe(true);
  });

  it("refuses a bad code, an unknown or club source, and a missing or long label, field by field", () => {
    expect(validateCampaignInput({ code: "", source: "x", label: "" })).toEqual({ ok: false, errors: { code: "required", source: "unknown", label: "required" } });
    expect(validateCampaignInput({ code: "li--kemal", source: "other", label: "a" })).toEqual({ ok: false, errors: { code: "format" } });
    expect(validateCampaignInput({ code: "-li", source: "other", label: "a" })).toEqual({ ok: false, errors: { code: "format" } });
    expect(validateCampaignInput({ code: "li_kemal", source: "other", label: "a" })).toEqual({ ok: false, errors: { code: "format" } });
    expect(validateCampaignInput({ code: "a".repeat(POOL_CAMPAIGN_CODE_MAX + 1), source: "other", label: "a" })).toEqual({ ok: false, errors: { code: "too-long" } });
    expect(validateCampaignInput({ code: "ok", source: "other", label: "a".repeat(POOL_CAMPAIGN_LABEL_MAX + 1) })).toEqual({ ok: false, errors: { label: "too-long" } });
    // A club's code comes with its share post (slice G3), not from this page.
    expect(validateCampaignInput({ code: "club-fnf", source: "club", label: "FNF" })).toEqual({ ok: false, errors: { source: "unknown" } });
    expect(validateCampaignInput(null)).toEqual({ ok: false, errors: { code: "required", source: "unknown", label: "required" } });
  });

  it("the owner's sources are the vocabulary's, less club", () => {
    expect([...POOL_CAMPAIGN_OWNER_SOURCES]).toEqual(POOL_CAMPAIGN_SOURCES.filter((s) => s !== "club"));
  });

  it("counts sign-ups per code: started (still waiting for WhatsApp) and confirmed", () => {
    const counts = campaignSignupCounts([
      { sourceCode: "li-kemal", status: "pending-verify" },
      { sourceCode: "li-kemal", status: "active" },
      { sourceCode: "li-kemal", status: "paused" },
      { sourceCode: "li-kemal", status: "stopped" },
      { sourceCode: "lf-sutton", status: "active" },
      { sourceCode: null, status: "active" },
    ]);
    expect(counts.get("li-kemal")).toEqual({ waiting: 1, confirmed: 3 });
    expect(counts.get("lf-sutton")).toEqual({ waiting: 0, confirmed: 1 });
    expect(counts.get("nothing")).toBeUndefined();
    // Grouped rows (a database groupBy) carry their own count.
    expect(campaignSignupCounts([{ sourceCode: "x", status: "active", count: 4 }, { sourceCode: "x", status: "pending-verify", count: 2 }]).get("x")).toEqual({ waiting: 2, confirmed: 4 });
  });
});

describe("attribution", () => {
  it("is first touch: the source of the sign-up he confirmed, never rewritten by a later link", () => {
    expect(POOL_ATTRIBUTION).toBe("first-touch");
  });

  const live = (userId: string, over: Partial<{ status: string; chain: string[] }> = {}) => ({ userId, status: over.status ?? "active", chain: over.chain ?? [] });

  it("keeps a friend's referral", () => {
    expect(settleReferral({ friendUserId: "u-friend", friendAccountExisted: false, referrer: live("u-ref") })).toEqual({ keep: true });
    expect(settleReferral({ friendUserId: "u-friend", friendAccountExisted: false, referrer: live("u-ref", { status: "paused" }) })).toEqual({ keep: true });
  });

  it("nothing to settle without a referrer", () => {
    expect(settleReferral({ friendUserId: "u-friend", friendAccountExisted: false, referrer: null })).toEqual({ keep: false, reason: "no-referrer" });
  });

  it("ignores a self-referral (his own link, confirmed from his own number)", () => {
    expect(settleReferral({ friendUserId: "u-ref", friendAccountExisted: true, referrer: live("u-ref") })).toEqual({ keep: false, reason: "self" });
  });

  it("ignores a loop: the friend is already up the referrer's own chain", () => {
    expect(settleReferral({ friendUserId: "u-a", friendAccountExisted: false, referrer: live("u-b", { chain: ["u-a"] }) })).toEqual({ keep: false, reason: "loop" });
    expect(settleReferral({ friendUserId: "u-a", friendAccountExisted: false, referrer: live("u-c", { chain: ["u-b", "u-a"] }) })).toEqual({ keep: false, reason: "loop" });
  });

  it("ignores a referrer who has stopped (withdrew consent)", () => {
    expect(settleReferral({ friendUserId: "u-friend", friendAccountExisted: false, referrer: live("u-ref", { status: "stopped" }) })).toEqual({ keep: false, reason: "referrer-stopped" });
  });

  it("ignores a referral of a number that was already on MatchTime", () => {
    expect(settleReferral({ friendUserId: "u-member", friendAccountExisted: true, referrer: live("u-ref") })).toEqual({ keep: false, reason: "existing-user" });
  });

  it("a referral counts for rewards only once the friend has played, and only once", () => {
    expect(referralCountsForReward({ referrerUserId: "u-ref", referralCountedAt: null, friendHasPlayed: false })).toBe(false);
    expect(referralCountsForReward({ referrerUserId: "u-ref", referralCountedAt: null, friendHasPlayed: true })).toBe(true);
    expect(referralCountsForReward({ referrerUserId: "u-ref", referralCountedAt: new Date(), friendHasPlayed: true })).toBe(false);
    expect(referralCountsForReward({ referrerUserId: null, referralCountedAt: null, friendHasPlayed: true })).toBe(false);
  });
});
