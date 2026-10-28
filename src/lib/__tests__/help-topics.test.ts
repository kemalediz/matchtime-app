/**
 * HELP THAT SAYS WHAT EACH THING DOES, WHETHER IT IS ON, AND HOW TO SWITCH
 * IT (Kemal, 2026-10-28).
 *
 * The topic comes from the question extractor (`how_it_works`); this pins
 * what `buildHelpReply` does with it: the three new topics (partner clubs,
 * the pool, settings), the on/off line on every flag topic, who is told how
 * to switch (organisers only), and the links (each topic's own card on the
 * settings page, a public address in a group, the organiser's signed-in
 * link by DM). No database, no model.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const orgFindUnique = vi.fn();
const partnershipCount = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    clubPartnership: { count: (...a: unknown[]) => partnershipCount(...a) },
  },
}));
const loadPartnerAskSettings = vi.fn();
vi.mock("@/lib/club-partnership", () => ({ loadPartnerAskSettings: (...a: unknown[]) => loadPartnerAskSettings(...a) }));

import { buildHelpReply, helpPagesNeeded, type HelpFeatures, type HelpTopic } from "@/lib/onboarding-conversation";
import { HELP_TOPIC_ANCHOR, SETTINGS_ANCHORS, helpTopicSettingsPath, settingsAnchorPath } from "@/lib/help-links";
import { HELP_CLUB_FACTS_OFF, loadHelpClubFacts } from "@/lib/help-club-facts";
import { HELP_FEATURES } from "@/lib/pipeline/types";

const BASE: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: true,
};
const POOL = {
  closed: { open: false, platformOpen: false, clubFlag: true },
  off: { open: false, platformOpen: true, clubFlag: false },
  on: { open: true, platformOpen: true, clubFlag: true },
};
const PARTNERS = {
  none: { active: 0, askWhen: "off" as const },
  notAsked: { active: 2, askWhen: "off" as const },
  onRequest: { active: 1, askWhen: "on-request" as const },
  auto: { active: 3, askWhen: "auto" as const },
};
const SIGNED = "https://mt.example/r/signed";
const PUBLIC = "https://matchtime.ai";

describe("the settings links (help-links.ts)", () => {
  it("are the fixed card ids the settings page gives its cards", () => {
    expect([...SETTINGS_ANCHORS]).toEqual([
      "player-pool", "partner-clubs", "pool-auto-ask", "play-style", "pool-club-share", "group-invite-link", "quiet-hours",
      "payments", "monthly-squad", "posters", "billing", "reminders", "attendance", "ratings", "mom", "teams", "club-details", "admin-group",
    ]);
  });

  it("each switchable topic links to its own card; the rest to the page", () => {
    expect(helpTopicSettingsPath("pool")).toBe("/admin/settings#player-pool");
    expect(helpTopicSettingsPath("partners")).toBe("/admin/settings#partner-clubs");
    expect(helpTopicSettingsPath("availability")).toBe("/admin/settings#attendance");
    expect(helpTopicSettingsPath("payments")).toBe("/admin/settings#payments");
    expect(helpTopicSettingsPath("settings")).toBe("/admin/settings");
    expect(helpTopicSettingsPath(null)).toBe("/admin/settings");
    for (const a of Object.values(HELP_TOPIC_ANCHOR)) expect(SETTINGS_ANCHORS).toContain(a);
    expect(settingsAnchorPath("mom")).toBe("/admin/settings#mom");
  });

  it("an organiser's DM mints one link: the topic's card", () => {
    expect(helpPagesNeeded("pool", "admin")).toEqual(["topic"]);
    expect(helpPagesNeeded("settings", "admin")).toEqual(["topic"]);
    expect(helpPagesNeeded("pool", "player")).toEqual([]);
  });
});

describe("help pool", () => {
  const pool = (state: keyof typeof POOL, audience: "group" | "admin" | "player", lang = "en", links?: Record<string, string>) =>
    buildHelpReply("pool", { ...BASE, pool: POOL[state] }, lang, { audience, ...(links ? { links } : {}) });

  it("a player: what it is and how to join (Play elsewhere too), and whether this club asks it; never how to switch", () => {
    for (const state of ["closed", "off", "on"] as const) {
      const r = pool(state, "player");
      expect(r).toContain("Turn on *Play elsewhere too* on your MatchTime profile.");
      expect(r).not.toMatch(/https?:\/\//);
    }
    expect(pool("on", "player")).toContain("✅ This club also asks the pool when it's short.");
    expect(pool("off", "player")).toContain("This club doesn't ask the pool for players.");
    expect(pool("closed", "player")).toContain("The pool isn't open yet: sign up now and you're on the early list.");
  });

  it("the players' group, pool off: the admins' pointer, public link to the card", () => {
    expect(pool("off", "group")).toContain(`An admin can switch it on with *Player pool* on the settings page:\n${PUBLIC}/admin/settings#player-pool`);
    expect(pool("on", "group")).not.toContain("/admin/settings");
  });

  it("an organiser: on or off for the club, and how to switch it, with the card's link", () => {
    expect(pool("off", "admin", "en", { topic: SIGNED })).toContain(`❌ It's off for your club. To switch it on, turn on *Player pool* here:\n${SIGNED}`);
    const on = pool("on", "admin", "en", { topic: SIGNED });
    expect(on).toContain("✅ It's on for your club.");
    expect(on).toContain("*@Match Time ask the player pool for 2 players*");
    expect(on).toContain("*Ask the player pool automatically*");
    expect(on).toContain(`To switch it off, turn off *Player pool*:\n${SIGNED}`);
    // In a group an organiser gets the public address, never a sign-in link.
    expect(pool("off", "admin")).toContain(`${PUBLIC}/admin/settings#player-pool`);
  });

  it("an organiser while the platform switch is off: not open yet, nothing to switch, no link", () => {
    const r = pool("closed", "admin", "en", { topic: SIGNED });
    expect(r).toContain("The pool isn't open yet.");
    expect(r).not.toContain(SIGNED);
  });

  it("Turkish, every state and audience: the card's Turkish title", () => {
    expect(pool("off", "admin", "tr", { topic: SIGNED })).toContain("*Oyuncu havuzu* ayarını aç");
    expect(pool("on", "player", "tr")).toContain("*Başka yerlerde de oyna*");
  });
});

describe("help partners", () => {
  const partners = (state: keyof typeof PARTNERS, audience: "group" | "admin" | "player", lang = "en") =>
    buildHelpReply("partners", { ...BASE, partners: PARTNERS[state] }, lang, { audience, links: audience === "admin" ? { topic: SIGNED } : undefined });

  it("an organiser is told which half is missing: no partner club, or not asked", () => {
    expect(partners("none", "admin")).toContain(`❌ Your club has no partner clubs yet. Find clubs near you and send a request on your settings page:\n${SIGNED}`);
    expect(partners("notAsked", "admin")).toContain("⏸️ Your club has 2 partner clubs, but MatchTime doesn't ask them for players. To switch it on, choose when under *Ask partner clubs for players*:");
    expect(partners("onRequest", "admin")).toContain("✅ It's on: your club has 1 partner club, and MatchTime asks them when you ask it to.");
    expect(partners("auto", "admin")).toContain("asks them by itself on match day, or when you ask it to");
  });

  it("a player: what affects him, how many partner clubs, no link", () => {
    expect(partners("auto", "player")).toContain("✅ This club has 3 partner clubs.");
    expect(partners("none", "player")).toContain("❌ This club has no partner clubs yet.");
    for (const s of ["none", "auto"] as const) expect(partners(s, "player")).not.toMatch(/https?:\/\//);
    expect(partners("none", "group")).toContain(`${PUBLIC}/admin/settings#partner-clubs`);
  });

  it("Turkish", () => {
    expect(partners("notAsked", "admin", "tr")).toContain("*Partner kulüplerden oyuncu iste*");
    expect(partners("auto", "player", "tr")).toContain("✅ Bu kulübün 3 partner kulübü var.");
  });
});

describe("help settings", () => {
  it("an organiser: tabs, Find a setting, the page; a player: ask the organisers", () => {
    const admin = buildHelpReply("settings", BASE, "en", { audience: "admin", links: { topic: SIGNED } });
    expect(admin).toContain("*Find a setting*");
    expect(admin).toContain(SIGNED);
    expect(buildHelpReply("settings", BASE, "en", { audience: "group" })).toContain(`${PUBLIC}/admin/settings`);
    expect(buildHelpReply("settings", BASE, "en", { audience: "player" })).not.toMatch(/https?:\/\//);
  });
});

describe("every flag topic says whether it is on, and an organiser where to switch it", () => {
  const FLAG: Array<[HelpTopic, keyof HelpFeatures, string]> = [
    ["availability", "attendance", "attendance"],
    ["teams", "teamBalancing", "teams"],
    ["mom", "momVoting", "mom"],
    ["ratings", "playerRating", "ratings"],
    ["reminders", "reminders", "reminders"],
    ["payments", "paymentCollection", "payments"],
  ];
  for (const [topic, flag, anchor] of FLAG) {
    it(`${topic}: on, off, by audience`, () => {
      expect(buildHelpReply(topic, BASE, "en", { audience: "group" }).endsWith("\n\n✅ It's on for this club.")).toBe(true);
      expect(buildHelpReply(topic, BASE, "en", { audience: "admin" })).toContain(
        `✅ It's on for your club. To switch it off or change how it works:\n${PUBLIC}/admin/settings#${anchor}`,
      );
      const off = { ...BASE, [flag]: false };
      expect(buildHelpReply(topic, off, "en", { audience: "group" })).toContain(`${PUBLIC}/admin/settings#${anchor}`);
      expect(buildHelpReply(topic, off, "en", { audience: "admin", links: { topic: SIGNED } })).toContain(`:\n${SIGNED}`);
      expect(buildHelpReply(topic, off, "en", { audience: "player" })).not.toMatch(/https?:\/\//);
    });
  }
});

describe("bare help lists what applies to this club", () => {
  it("the pool and partner clubs only while they are on", () => {
    const off = buildHelpReply(null, { ...BASE, pool: POOL.off, partners: PARTNERS.notAsked });
    expect(off).not.toContain("help pool*");
    expect(off).not.toContain("help partners*");
    const on = buildHelpReply(null, { ...BASE, pool: POOL.on, partners: PARTNERS.auto });
    expect(on).toContain("• *@Match Time help pool*: the player pool");
    expect(on).toContain("• *@Match Time help partners*: partner clubs");
    expect(on).toContain("• *@Match Time help settings*: where your settings are");
  });

  it("an organiser also hears what is switched off; the pool only when it could be switched on", () => {
    const admin = (pool: (typeof POOL)[keyof typeof POOL]) =>
      buildHelpReply(null, { ...BASE, momVoting: false, pool, partners: PARTNERS.none }, "en", { audience: "admin", links: { settings: SIGNED } });
    expect(admin(POOL.off)).toContain("🔧 Switched off for your club: Man of the Match, partner clubs, the player pool.");
    expect(admin(POOL.closed)).toContain("🔧 Switched off for your club: Man of the Match, partner clubs.");
    expect(buildHelpReply(null, { ...BASE, momVoting: false }, "en", { audience: "group" })).not.toContain("Switched off");
  });

  it("an organiser in a group gets the public settings address, not 'signed in'", () => {
    const r = buildHelpReply(null, BASE, "en", { audience: "admin" });
    expect(r.endsWith(`⚙️ Your club's settings:\n${PUBLIC}/admin/settings`)).toBe(true);
    expect(buildHelpReply(null, BASE, "en", { audience: "admin", links: { settings: SIGNED } })).toContain(`signed in:\n${SIGNED}`);
  });
});

describe("the house rules hold on every new answer", () => {
  it("no em or en dash, no 'free', 'bench' never 'waiting list', EN and TR", () => {
    const outs: string[] = [];
    for (const lang of ["en", "tr"]) {
      for (const audience of ["group", "admin", "player"] as const) {
        for (const pool of Object.values(POOL)) {
          for (const partners of Object.values(PARTNERS)) {
            for (const tp of ["pool", "partners", "settings", null] as const) {
              outs.push(buildHelpReply(tp, { ...BASE, pool, partners }, lang, { audience }));
            }
          }
        }
      }
    }
    for (const o of outs) {
      expect(o).not.toMatch(/[—–]/);
      expect(o).not.toMatch(/waiting list/i);
    }
    for (const o of outs.filter((x) => !x.includes("MatchTime help") && !x.includes("MatchTime yardım"))) {
      expect(o).not.toMatch(/\bfree\b|ücretsiz/i);
      expect(o).not.toMatch(/ \/ /);
    }
  });

  it("every topic the extractor can name has an answer", () => {
    for (const tp of HELP_FEATURES) expect(buildHelpReply(tp, BASE, "en", { audience: "admin" }).length).toBeGreaterThan(40);
  });
});

describe("loadHelpClubFacts", () => {
  beforeEach(() => vi.clearAllMocks());
  const OPEN = { MT_POOL_OPEN: "1" };

  it("the pool: THE ONE RULE, the platform switch as resolved AND the club's flag", async () => {
    partnershipCount.mockResolvedValue(0);
    loadPartnerAskSettings.mockResolvedValue({ when: "off" });
    orgFindUnique.mockResolvedValue({ featurePlayerPool: true });
    expect((await loadHelpClubFacts("o1", OPEN)).pool).toEqual({ open: true, platformOpen: true, clubFlag: true });
    expect((await loadHelpClubFacts("o1", { MT_POOL_OPEN: "0" })).pool).toEqual({ open: false, platformOpen: false, clubFlag: true });
    expect((await loadHelpClubFacts("o1", {})).pool.open).toBe(false);
    orgFindUnique.mockResolvedValue({ featurePlayerPool: false });
    expect((await loadHelpClubFacts("o1", OPEN)).pool).toEqual({ open: false, platformOpen: true, clubFlag: false });
  });

  it("partner clubs: the active ones it asks, and the ask setting through its one reader", async () => {
    orgFindUnique.mockResolvedValue({ featurePlayerPool: false });
    partnershipCount.mockResolvedValue(2);
    loadPartnerAskSettings.mockResolvedValue({ when: "auto" });
    expect((await loadHelpClubFacts("o1", OPEN)).partners).toEqual({ active: 2, askWhen: "auto" });
    expect(partnershipCount).toHaveBeenCalledWith({ where: { askerOrgId: "o1", status: "active" } });
  });

  it("a database error reads as off: the help then says how to switch it on", async () => {
    orgFindUnique.mockRejectedValue(new Error("connection terminated"));
    partnershipCount.mockResolvedValue(1);
    loadPartnerAskSettings.mockResolvedValue({ when: "auto" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadHelpClubFacts("o1", OPEN)).toEqual(HELP_CLUB_FACTS_OFF);
    spy.mockRestore();
  });
});
