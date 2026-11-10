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

import { buildHelpReply, helpFeaturesFrom, helpPagesNeeded, type HelpFeatures, type HelpTopic } from "@/lib/onboarding-conversation";
import { HELP_TOPIC_ANCHOR, SETTINGS_ANCHORS, helpTopicSettingsPath, settingsAnchorPath } from "@/lib/help-links";
import { HELP_CLUB_FACTS_OFF, loadHelpClubFacts } from "@/lib/help-club-facts";
import { HELP_FEATURES, playersHelpTopic } from "@/lib/pipeline/types";

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
  none: { active: 0 },
  one: { active: 1 },
  three: { active: 3 },
};
const SIGNED = "https://mt.example/r/signed";
const PUBLIC = "https://matchtime.ai";

describe("the settings links (help-links.ts)", () => {
  it("are the fixed card ids the settings page gives its cards", () => {
    expect([...SETTINGS_ANCHORS]).toEqual([
      "player-pool", "partner-clubs", "play-style", "pool-club-share", "group-invite-link", "quiet-hours",
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
    // Nothing asks by itself (Kemal, 2026-11-08): no automatic setting to turn on.
    expect(on).not.toMatch(/automatically|by itself/);
    expect(on).toContain("together or separately, on WhatsApp or on the match page");
    expect(on).toContain("or tick it on the match page");
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
    const on = pool("on", "admin", "tr", { topic: SIGNED });
    expect(on).toContain("birlikte ya da ayrı ayrı");
    expect(on).not.toMatch(/kendiliğinden|otomatik/);
  });
});

describe("help partners", () => {
  const partners = (state: keyof typeof PARTNERS, audience: "group" | "admin" | "player", lang = "en") =>
    buildHelpReply("partners", { ...BASE, partners: PARTNERS[state] }, lang, { audience, links: audience === "admin" ? { topic: SIGNED } : undefined });

  it("an organiser: once paired it is on, asked on WhatsApp or the match page, never by itself (Kemal, 2026-11-08)", () => {
    expect(partners("none", "admin")).toContain(`❌ Your club has no partner clubs yet. Find clubs near you and send a request on your settings page:\n${SIGNED}`);
    expect(partners("one", "admin")).toContain("✅ It's on: your club has 1 partner club. Ask me in your club's WhatsApp group");
    expect(partners("three", "admin")).toContain("✅ It's on: your club has 3 partner clubs.");
    expect(partners("three", "admin")).toContain(
      "Once you're paired, an organiser can ask your partner clubs and the player pool for players, together or separately, on WhatsApp or on the match page.",
    );
    expect(partners("three", "admin")).toContain(SIGNED);
    for (const st of ["none", "one", "three"] as const) {
      expect(partners(st, "admin")).not.toMatch(/by itself|automatically|⏸️|choose when/);
      expect(partners(st, "admin", "tr")).not.toMatch(/kendiliğinden|ne zaman isteneceğini/);
    }
  });

  it("a player: what affects him, how many partner clubs, no link", () => {
    expect(partners("three", "player")).toContain("✅ This club has 3 partner clubs.");
    expect(partners("none", "player")).toContain("❌ This club has no partner clubs yet.");
    for (const s of ["none", "three"] as const) expect(partners(s, "player")).not.toMatch(/https?:\/\//);
    expect(partners("none", "group")).toContain(`${PUBLIC}/admin/settings#partner-clubs`);
  });

  it("Turkish", () => {
    expect(partners("three", "admin", "tr")).toContain("✅ Açık: kulübünün 3 partner kulübü var.");
    expect(partners("three", "admin", "tr")).toContain("birlikte ya da ayrı ayrı, WhatsApp'tan ya da maç sayfasından");
    expect(partners("three", "player", "tr")).toContain("✅ Bu kulübün 3 partner kulübü var.");
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
  // The short menu (2026-11-10): one closing line names every topic the
  // club can ask about, on or off (Kemal: off features must be findable).
  const topicsOf = (r: string) => r.slice(r.indexOf("Topics: "));
  it("the pool and partner clubs are listed while on or switchable on; a pool the platform has closed is not", () => {
    const off = topicsOf(buildHelpReply(null, { ...BASE, pool: POOL.off, partners: PARTNERS.none }));
    expect(off).toContain("partners");
    expect(off).toContain("pool");
    expect(topicsOf(buildHelpReply(null, { ...BASE, pool: POOL.closed, partners: PARTNERS.none }))).not.toContain("pool");
    const on = topicsOf(buildHelpReply(null, { ...BASE, pool: POOL.on, partners: PARTNERS.one }));
    expect(on).toContain("pool");
    expect(on).toContain("partners");
    expect(on).toContain("settings");
  });

  it("an organiser also hears what is switched off; the pool only when it could be switched on", () => {
    const admin = (pool: (typeof POOL)[keyof typeof POOL]) =>
      buildHelpReply(null, { ...BASE, momVoting: false, pool, partners: PARTNERS.none }, "en", { audience: "admin", links: { settings: SIGNED } });
    expect(admin(POOL.off)).toContain("💡 *Not on here yet*: Man of the Match, partner clubs, the player pool. Ask *@Match Time help mom* to see how they work and how to switch them on.");
    expect(admin(POOL.closed)).toContain("💡 *Not on here yet*: Man of the Match, partner clubs. Ask *@Match Time help mom*");
    expect(buildHelpReply(null, { ...BASE, momVoting: false }, "en", { audience: "group" })).not.toContain("Not on here yet");
  });

  it("an organiser in a group gets the public settings address, not 'signed in'", () => {
    const r = buildHelpReply(null, BASE, "en", { audience: "admin" });
    expect(r).toContain(`⚙️ Your club's settings:\n${PUBLIC}/admin/settings\n`);
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
    for (const tp of HELP_FEATURES) expect(buildHelpReply(playersHelpTopic(tp), BASE, "en", { audience: "admin" }).length).toBeGreaterThan(40);
  });
});

describe("loadHelpClubFacts", () => {
  beforeEach(() => vi.clearAllMocks());
  const OPEN = { MT_POOL_OPEN: "1" };

  it("the pool: THE ONE RULE, the platform switch as resolved AND the club's flag", async () => {
    partnershipCount.mockResolvedValue(0);
    orgFindUnique.mockResolvedValue({ featurePlayerPool: true });
    expect((await loadHelpClubFacts("o1", OPEN)).pool).toEqual({ open: true, platformOpen: true, clubFlag: true });
    expect((await loadHelpClubFacts("o1", { MT_POOL_OPEN: "0" })).pool).toEqual({ open: false, platformOpen: false, clubFlag: true });
    expect((await loadHelpClubFacts("o1", {})).pool.open).toBe(false);
    orgFindUnique.mockResolvedValue({ featurePlayerPool: false });
    expect((await loadHelpClubFacts("o1", OPEN)).pool).toEqual({ open: false, platformOpen: true, clubFlag: false });
  });

  it("partner clubs: the active ones it asks; no ask setting is read (the pairing is the switch)", async () => {
    orgFindUnique.mockResolvedValue({ featurePlayerPool: false });
    partnershipCount.mockResolvedValue(2);
    expect((await loadHelpClubFacts("o1", OPEN)).partners).toEqual({ active: 2 });
    expect(partnershipCount).toHaveBeenCalledWith({ where: { askerOrgId: "o1", status: "active" } });
  });

  it("a database error reads as off: the help then says how to switch it on", async () => {
    orgFindUnique.mockRejectedValue(new Error("connection terminated"));
    partnershipCount.mockResolvedValue(1);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadHelpClubFacts("o1", OPEN)).toEqual(HELP_CLUB_FACTS_OFF);
    spy.mockRestore();
  });
});

describe("help availability for an organiser of a monthly club (2026-11-03)", () => {
  it("says the month starts from his list and how he matches names it cannot, in English and Turkish", () => {
    const monthly = { ...BASE, monthly: true };
    const en = buildHelpReply("availability", monthly, "en", { audience: "admin" });
    expect(en).toContain("*Monthly squad:*");
    expect(en).toContain(`_"Craig is 3"_`);
    expect(en).toContain("months page");
    expect(buildHelpReply("availability", monthly, "tr", { audience: "admin" })).toContain("*Aylık kadro:*");
  });
  it("not for the players' group, nor for a weekly club", () => {
    expect(buildHelpReply("availability", { ...BASE, monthly: true }, "en", { audience: "group" })).not.toContain("Monthly squad");
    expect(buildHelpReply("availability", BASE, "en", { audience: "admin" })).not.toContain("Monthly squad");
  });
  it("helpFeaturesFrom reads the squad mode", () => {
    const f = { attendance: true, teamBalancing: true, momVoting: true, playerRating: true, statsQa: true, reminders: true, bench: true, paymentTracking: false, paymentCollection: false };
    expect(helpFeaturesFrom({ ...f, squadMode: "monthly" }).monthly).toBe(true);
    expect(helpFeaturesFrom({ ...f, squadMode: "weekly" }).monthly).toBe(false);
  });
});
