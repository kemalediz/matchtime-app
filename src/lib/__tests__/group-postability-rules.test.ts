/**
 * Can MatchTime post in a group (2026-10-14): the server's pure half.
 * The same rule as the Pi's whatsapp-bot/src/group-postability.ts.
 */
import { describe, expect, it } from "vitest";
import {
  connectNotPostableText,
  decideGroupPostability,
  adminGroupNotPostableText,
  liveGroupNotPostableText,
  parsePostabilityInput,
  planPostStateChange,
} from "../group-postability-rules";

const NOW = new Date("2026-10-14T12:00:00Z");
const EARLIER = new Date("2026-10-14T09:00:00Z");

describe("parsePostabilityInput", () => {
  it("reads the three booleans", () => {
    expect(parsePostabilityInput({ announce: true, communityAnnounce: false, botIsAdmin: false })).toEqual({
      announce: true,
      communityAnnounce: false,
      botIsAdmin: false,
    });
  });
  it("anything else is no reading at all (never blocks on a guess)", () => {
    expect(parsePostabilityInput(undefined)).toBeNull();
    expect(parsePostabilityInput(null)).toBeNull();
    expect(parsePostabilityInput("yes")).toBeNull();
    expect(parsePostabilityInput({ announce: "true", communityAnnounce: false, botIsAdmin: false })).toBeNull();
    expect(parsePostabilityInput({ announce: true })).toBeNull();
  });
});

describe("decideGroupPostability", () => {
  it("is the Pi's rule", () => {
    expect(decideGroupPostability({ announce: false, communityAnnounce: false, botIsAdmin: false })).toEqual({
      canPost: true,
      reason: "ok",
    });
    expect(decideGroupPostability({ announce: true, communityAnnounce: false, botIsAdmin: false })).toEqual({
      canPost: false,
      reason: "admin-only",
    });
    expect(decideGroupPostability({ announce: true, communityAnnounce: true, botIsAdmin: false })).toEqual({
      canPost: false,
      reason: "community-announce",
    });
    expect(decideGroupPostability({ announce: true, communityAnnounce: true, botIsAdmin: true }).canPost).toBe(true);
  });
});

describe("planPostStateChange: pause, tell once, resume", () => {
  it("first reading blocked: starts the stretch and tells the organiser", () => {
    expect(planPostStateChange({ prev: null, canPost: false, now: NOW })).toEqual({
      blockedSince: NOW,
      noticeDue: true,
      becamePostable: false,
    });
  });

  it("still blocked and already told: not told again", () => {
    expect(
      planPostStateChange({ prev: { canPost: false, blockedSince: EARLIER, noticeSentAt: EARLIER }, canPost: false, now: NOW }),
    ).toEqual({ blockedSince: EARLIER, noticeDue: false, becamePostable: false });
  });

  it("blocked again within a day of the last notice (the setting flapped): NOT told again", () => {
    const resumedAt = new Date("2026-10-14T10:00:00Z");
    expect(
      planPostStateChange({ prev: { canPost: true, blockedSince: null, noticeSentAt: EARLIER }, canPost: false, now: NOW }),
    ).toEqual({ blockedSince: NOW, noticeDue: false, becamePostable: false });
    expect(resumedAt.getTime()).toBeLessThan(NOW.getTime());
  });

  it("blocked again a day or more after the last notice: told again", () => {
    const dayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(
      planPostStateChange({ prev: { canPost: true, blockedSince: null, noticeSentAt: dayAgo }, canPost: false, now: NOW }).noticeDue,
    ).toBe(true);
  });

  it("still blocked, never told (the earlier notice could not go): told now", () => {
    expect(
      planPostStateChange({ prev: { canPost: false, blockedSince: EARLIER, noticeSentAt: null }, canPost: false, now: NOW })
        .noticeDue,
    ).toBe(true);
  });

  it("postable again: the stretch ends", () => {
    expect(
      planPostStateChange({ prev: { canPost: false, blockedSince: EARLIER, noticeSentAt: EARLIER }, canPost: true, now: NOW }),
    ).toEqual({ blockedSince: null, noticeDue: false, becamePostable: true });
  });

  it("postable and was postable: nothing", () => {
    expect(planPostStateChange({ prev: { canPost: true, blockedSince: null, noticeSentAt: null }, canPost: true, now: NOW })).toEqual({
      blockedSince: null,
      noticeDue: false,
      becamePostable: false,
    });
    expect(planPostStateChange({ prev: null, canPost: true, now: NOW }).becamePostable).toBe(false);
  });
});

const NO_DASH = /[–—]/;

describe("the organiser's DMs, English and Turkish", () => {
  it("connect, admin-only: says why, and both ways out", () => {
    const en = connectNotPostableText("en", { group: "Riverside Announcements", reason: "admin-only" });
    expect(en).toContain('"Riverside Announcements"');
    expect(en).toMatch(/only admins can send messages/);
    expect(en).toMatch(/group admin/);
    expect(en).toMatch(/players chat in/);
    const tr = connectNotPostableText("tr", { group: "Riverside Duyurular", reason: "admin-only" });
    expect(tr).toContain('"Riverside Duyurular"');
    expect(tr).toMatch(/yalnızca yöneticiler/);
    expect(tr).not.toBe(en);
  });

  it("connect, community announcements: names it and recommends the players' group", () => {
    const en = connectNotPostableText("en", { group: "Riverside", reason: "community-announce" });
    expect(en).toMatch(/announcements group/);
    expect(en).toMatch(/recommended/);
    const tr = connectNotPostableText("tr", { group: null, reason: "community-announce" });
    expect(tr).toMatch(/duyuru grubu/);
    expect(tr).toMatch(/önerilen/);
  });

  it("the live club and the admin group notices", () => {
    expect(liveGroupNotPostableText("en", { club: "Sutton FC", reason: "admin-only" })).toMatch(/Sutton FC/);
    expect(liveGroupNotPostableText("tr", { club: "Sutton FC", reason: "community-announce" })).toMatch(/duyuru/);
    expect(adminGroupNotPostableText("en", { club: "Sutton FC", group: "Sutton admins" })).toMatch(/by DM/);
    expect(adminGroupNotPostableText("tr", { club: "Sutton FC", group: null })).toMatch(/yönetici grubu/i);
  });

  it("no em or en dashes in any of them", () => {
    for (const lang of ["en", "tr"]) {
      for (const reason of ["admin-only", "community-announce"] as const) {
        expect(connectNotPostableText(lang, { group: "G", reason })).not.toMatch(NO_DASH);
        expect(connectNotPostableText(lang, { group: null, reason })).not.toMatch(NO_DASH);
        expect(liveGroupNotPostableText(lang, { club: "C", reason })).not.toMatch(NO_DASH);
      }
      expect(adminGroupNotPostableText(lang, { club: "C", group: "G" })).not.toMatch(NO_DASH);
    }
  });
});
