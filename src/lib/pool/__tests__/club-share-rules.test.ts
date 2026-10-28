/**
 * A club's ONE share post (growth slice G3): the pure rules. The I/O half
 * is `club-share.test.ts`; the real database, the real settings page and
 * the scheduler poll are e2e/sim/pool/club-share.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { poolSwitchEnv } from "../flags";
import {
  CLUB_SHARE_KIND,
  clubShareCampaignCode,
  clubShareCampaignLabel,
  clubShareKey,
  clubSharePostText,
  clubShareShown,
  clubShareStatusLine,
  clubShareView,
} from "../club-share-rules";
import { POOL_CAMPAIGN_CODE_MAX } from "../growth-rules";

const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("the club's campaign code", () => {
  it("is club-<slug>", () => {
    expect(clubShareCampaignCode("fnf")).toBe("club-fnf");
    expect(clubShareCampaignCode("sutton-fc")).toBe("club-sutton-fc");
  });

  it("is always a valid campaign code, whatever the slug holds", () => {
    for (const slug of ["Sutton FC", "  fnf  ", "çalışkan-spor", "a__b--c", "x".repeat(80), "-", ""]) {
      const code = clubShareCampaignCode(slug);
      expect(code, slug).toMatch(CODE_RE);
      expect(code.length, slug).toBeLessThanOrEqual(POOL_CAMPAIGN_CODE_MAX);
      expect(code.startsWith("club-") || code === "club", slug).toBe(true);
    }
    expect(clubShareCampaignCode("Sutton FC")).toBe("club-sutton-fc");
    expect(clubShareCampaignCode("çalışkan-spor")).toBe("club-caliskan-spor");
  });

  it("a second try (the code is someone else's) adds a number, still within the limit", () => {
    expect(clubShareCampaignCode("fnf", 2)).toBe("club-fnf-2");
    const long = clubShareCampaignCode("x".repeat(80), 12);
    expect(long).toMatch(CODE_RE);
    expect(long.endsWith("-12")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(POOL_CAMPAIGN_CODE_MAX);
  });

  it("its label on the owner's campaign page names the club, never a person", () => {
    expect(clubShareCampaignLabel("FNF")).toBe("FNF share post");
    expect(clubShareCampaignLabel("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("once per club, ever", () => {
  it("the claim key is the club's own, with no date or account in it", () => {
    expect(clubShareKey("org1")).toBe("org-org1:pool-club-share");
    expect(clubShareKey("org1")).toBe(clubShareKey("org1"));
    expect(clubShareKey("org1")).not.toBe(clubShareKey("org2"));
    expect(CLUB_SHARE_KIND).toBe("pool-club-share");
  });
});

describe("who sees the card", () => {
  it("only a club with the player pool on, while the platform switch is on", () => {
    expect(clubShareShown({ featurePlayerPool: true }, poolSwitchEnv(true))).toBe(true);
    expect(clubShareShown({ featurePlayerPool: true }, poolSwitchEnv(false))).toBe(false);
    expect(clubShareShown({ featurePlayerPool: false }, poolSwitchEnv(true))).toBe(false);
    expect(clubShareShown(null, poolSwitchEnv(true))).toBe(false);
  });
});

describe("the post", () => {
  const URL = "https://matchtime.test/play?src=club-fnf";

  it("is in the club's language, with the club's link", () => {
    const en = clubSharePostText("en", URL);
    const tr = clubSharePostText("tr", URL);
    expect(en).toContain(URL);
    expect(tr).toContain(URL);
    expect(en).toContain("Play elsewhere too");
    expect(tr).toContain("Başka yerlerde de oyna");
    expect(tr).not.toBe(en);
    expect(clubSharePostText("de", URL)).toBe(en);
  });

  it("carries one link only: the club's", () => {
    for (const text of [clubSharePostText("en", URL), clubSharePostText("tr", URL)]) {
      expect(text.match(/https?:\/\/\S+/g)).toEqual([URL]);
    }
  });
});

describe("the card's state", () => {
  const base = { shown: true, hasGroup: true, sentAt: null };

  it("hidden with the pool off, whatever else", () => {
    expect(clubShareView({ ...base, shown: false })).toEqual({ kind: "hidden" });
    expect(clubShareView({ ...base, shown: false, sentAt: new Date() })).toEqual({ kind: "hidden" });
  });

  it("sent stays sent, with its date, even if the group is gone", () => {
    const at = new Date("2026-10-24T10:00:00Z");
    expect(clubShareView({ ...base, sentAt: at })).toEqual({ kind: "sent", sentAt: at });
    expect(clubShareView({ ...base, hasGroup: false, sentAt: at })).toEqual({ kind: "sent", sentAt: at });
  });

  it("claimed but its post not out yet (held by quiet hours, or waiting for the Pi): queued, with when", () => {
    const claimed = new Date("2026-10-27T23:10:00Z");
    const held = new Date("2026-10-28T09:00:00Z");
    expect(clubShareView({ ...base, sentAt: claimed, job: { sendAfter: held, sentAt: null } })).toEqual({ kind: "queued", sendAfter: held });
    expect(clubShareView({ ...base, sentAt: claimed, job: { sendAfter: null, sentAt: null } })).toEqual({ kind: "queued", sendAfter: null });
  });

  it("once the post is out: sent, on the day it went out", () => {
    const claimed = new Date("2026-10-27T23:10:00Z");
    const out = new Date("2026-10-28T09:00:30Z");
    expect(clubShareView({ ...base, sentAt: claimed, job: { sendAfter: new Date("2026-10-28T09:00:00Z"), sentAt: out } })).toEqual({
      kind: "sent",
      sentAt: out,
    });
  });

  it("a claim from before the post was linked to it (no job found): sent on the claim's day, as before", () => {
    const at = new Date("2026-10-24T10:00:00Z");
    expect(clubShareView({ ...base, sentAt: at, job: null })).toEqual({ kind: "sent", sentAt: at });
  });

  it("no players' group: shown, but Send is not offered", () => {
    expect(clubShareView({ ...base, hasGroup: false })).toEqual({ kind: "no-group" });
  });

  it("otherwise ready to send", () => {
    expect(clubShareView(base)).toEqual({ kind: "ready" });
  });
});

describe("the card's state line, London time, in the club's language", () => {
  const NOW = new Date("2026-10-28T00:30:00Z"); // 00:30 London, Wednesday 28 October (GMT)

  it("queued for later today: the time", () => {
    const at = { kind: "queued" as const, sendAfter: new Date("2026-10-28T09:00:00Z") };
    expect(clubShareStatusLine("en", at, NOW)).toBe("Queued: goes out at 09:00.");
    expect(clubShareStatusLine("tr", at, NOW)).toBe("Sırada: 09:00'da gönderilecek.");
  });

  it("queued for another day: the date as well", () => {
    const at = { kind: "queued" as const, sendAfter: new Date("2026-10-29T09:00:00Z") };
    expect(clubShareStatusLine("en", at, NOW)).toBe("Queued: goes out on 29 Oct 2026 at 09:00.");
    expect(clubShareStatusLine("tr", at, NOW)).toBe("Sırada: 29 Eki 2026, 09:00'da gönderilecek.");
  });

  it("queued with no hold, or a hold already past: in a minute or two", () => {
    for (const sendAfter of [null, new Date("2026-10-27T09:00:00Z")]) {
      expect(clubShareStatusLine("en", { kind: "queued", sendAfter }, NOW)).toBe("Queued: goes out in a minute or two.");
      expect(clubShareStatusLine("tr", { kind: "queued", sendAfter }, NOW)).toBe("Sırada: bir iki dakika içinde gönderilecek.");
    }
  });

  it("sent: the day, London time", () => {
    const at = { kind: "sent" as const, sentAt: new Date("2026-10-28T09:00:30Z") };
    expect(clubShareStatusLine("en", at, NOW)).toBe("Sent to your players' group on 28 Oct 2026.");
    expect(clubShareStatusLine("tr", at, NOW)).toBe("Oyuncu grubunuza 28 Eki 2026'da gönderildi.");
  });

  it("ready, no group or hidden: no line", () => {
    expect(clubShareStatusLine("en", { kind: "ready" }, NOW)).toBeNull();
    expect(clubShareStatusLine("en", { kind: "no-group" }, NOW)).toBeNull();
    expect(clubShareStatusLine("en", { kind: "hidden" }, NOW)).toBeNull();
  });
});
