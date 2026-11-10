/**
 * SHORT HELP MENUS (Kemal, 2026-11-10: "why this long menu when we say
 * @mt help").
 *
 * The admin group's (HQ) help was 22 lines and the players' group's about
 * 25: every feature had added a line. Now each is a short menu, and
 * "@Match Time help <topic>" gives that topic in full:
 *
 *   (a) each menu is at most 12 lines, English and Turkish, for every club
 *       shape, with the not-on line and the closing line counted;
 *   (b) every line of the old full HQ help (recorded from the builder
 *       BEFORE this change, fixtures/hq-help-full-before-short-menu.json)
 *       is in exactly one HQ topic, for every club shape, so nothing is
 *       lost;
 *   (c) every line the players' menu dropped is said by the topic it moved
 *       to;
 *   (d) a topic request reaches its detail (stubbed model);
 *   (e) the features a club has NOT switched on are named as available
 *       (Kemal: "why it never mentions not used features such as
 *       payments"), and "help <that topic>" says how it works and how to
 *       switch it on;
 *   (f) the closing line teaches the pattern with a real example and
 *       lists every topic word, off ones too; each topic ends with the way
 *       back to the menu.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildHqHelp,
  buildHqTopicLines,
  hqHelpTopicReply,
  HQ_HELP_TOPICS,
  hqTopicFor,
  type HqHelpGates,
} from "@/lib/admin-group-help";
import { buildHelpReply, type HelpFeatures } from "@/lib/onboarding-conversation";
import { clubHelpReply } from "@/lib/help-answer";
import { answerHqQuestion } from "@/lib/admin-group-question";
import type { OrgFeatures } from "@/lib/org-features";
import type { HelpClubFacts } from "@/lib/help-club-facts";
import type { ModelRequest, ModelResponse, PipelineModel } from "@/lib/pipeline/llm";
import { NOW, world } from "@/lib/pipeline/__tests__/helpers";
import { HELP_FEATURES } from "@/lib/pipeline/types";

const BEFORE: Record<string, string> = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/hq-help-full-before-short-menu.json"), "utf8"),
);

/** The fixture's key back to the gates it was recorded with. */
function gatesOf(key: string): { lang: string; gates: HqHelpGates } {
  const [lang, on] = key.split(":");
  const set = new Set(on.split("+"));
  return {
    lang,
    gates: { squad: set.has("squad"), graphics: true, picks: set.has("picks"), paid: set.has("paid"), free: set.has("free"), pool: set.has("pool") },
  };
}

const ALL_ON: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: true,
  pool: { open: true, platformOpen: true, clubFlag: true },
  partners: { active: 1 },
};
/** FNF's shape: no match fees, no partner clubs, the pool closed for the
 *  club while the platform has it open, the organisers announce and pick. */
const FNF: HelpFeatures = {
  ...ALL_ON,
  paymentCollection: false,
  pool: { open: false, platformOpen: true, clubFlag: false },
  partners: { active: 0 },
  organisersAnnounce: true,
  organiserPicks: true,
};
const ALL_OFF: HelpFeatures = {
  attendance: false,
  teamBalancing: false,
  momVoting: false,
  playerRating: false,
  statsQa: false,
  reminders: false,
  bench: false,
  paymentTracking: false,
  paymentCollection: false,
  pool: { open: false, platformOpen: false, clubFlag: false },
  partners: { active: 0 },
};
const MONTHLY: HelpFeatures = { ...ALL_ON, monthly: true, paymentCollection: false };
const SHAPES: Record<string, HelpFeatures> = { ALL_ON, FNF, ALL_OFF, MONTHLY };

const lineCount = (s: string) => s.split("\n").length;

describe("(a) the HQ menu is short", () => {
  it("at most 12 lines, EN and TR, every club shape and feature set", () => {
    let n = 0;
    for (const key of Object.keys(BEFORE)) {
      const { lang, gates } = gatesOf(key);
      for (const features of [undefined, ...Object.values(SHAPES)]) {
        const menu = buildHqHelp({ lang, ...gates, ...(features ? { features } : {}) });
        expect(lineCount(menu), `${key}\n${menu}`).toBeLessThanOrEqual(12);
        n++;
      }
    }
    expect(n).toBe(48 * 5);
  });

  it("the approved menu, word for word, for a weekly club with the pool open and everything on", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, free: true, pool: true, features: ALL_ON })).toBe(
      [
        `🛠️ *MatchTime in your admin group*`,
        `Tag me (type *@*, pick *Match Time*), then ask in your own words:`,
        ``,
        `📋 *Squad*: "put Bilal in", "Tom to the bench", "swap Tom for Ben", or paste the list`,
        `🟥🟦 *Teams*: "make the teams", "swap Sam and Alex", then *YES* to confirm`,
        `📣 *Finding players*: "ask the group", "ask the player pool for 2", "DM them"`,
        `🗓️ *The game*: "cancel Friday", "make it 8 a side", "move Monday's game to 20:15"`,
        `⚙️ *Settings*: "quiet hours 23:00 to 09:00", "we play with 12 to 16"`,
        `🖼️ *Graphics*: "send the poster"`,
        `❓ *Anything else*: just ask, I answer from what I know`,
        `ℹ️ To learn more about anything, tag me with *help* and the topic, for example *@Match Time help payments*. Topics: squad, teams, players, game, settings, graphics, payments, partners, pool, mom, ratings, reminders.`,
      ].join("\n"),
    );
  });

  it("Turkish, the same shape", () => {
    expect(buildHqHelp({ lang: "tr", squad: true, graphics: true, picks: false, paid: false, free: true, pool: true, features: ALL_ON })).toBe(
      [
        `🛠️ *Yönetici grubunda MatchTime*`,
        `Beni etiketleyin (*@* yazıp *Match Time*'ı seçin), sonra kendi cümlelerinizle sorun:`,
        ``,
        `📋 *Kadro*: "Bilal'i ekle", "Tom yedeğe", "Tom yedeğe, Ben kadroya" ya da listeyi yapıştırın`,
        `🟥🟦 *Takımlar*: "takımları kur", "Sam ile Alex'i değiştir", sonra onay için *EVET*`,
        `📣 *Oyuncu bulmak*: "gruba sor", "havuzdan 2 oyuncu iste", "onlara özelden yaz"`,
        `🗓️ *Maç*: "cuma maçını iptal et", "8'e 8 yapalım", "pazartesi maçını 20:15'e al"`,
        `⚙️ *Ayarlar*: "sessiz saatler 23:00 ile 09:00 arası", "12 ile 16 kişi arası oynuyoruz"`,
        `🖼️ *Görseller*: "posteri gönder"`,
        `❓ *Başka bir şey*: sormanız yeter, bildiklerimden yanıtlarım`,
        `ℹ️ Herhangi bir konuda daha fazlası için beni *yardım* ve konuyla etiketleyin, örneğin *@Match Time yardım ödeme*. Konular: kadro, takımlar, oyuncu bulma, maç, ayarlar, görseller, ödeme, partner, havuz, maçın adamı, puanlama, hatırlatma.`,
      ].join("\n"),
    );
  });

  it("a monthly club: no weekly squad, team or finding-players line, and no cancel example", () => {
    const menu = buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true, free: true, features: MONTHLY });
    expect(menu).not.toContain("*Squad*");
    expect(menu).not.toContain("*Teams*");
    expect(menu).not.toContain("*Finding players*");
    expect(menu).not.toContain("cancel Friday");
    expect(menu).toContain(`🗓️ *The game*: "make it 8 a side", "move Monday's game to 20:15"`);
  });

  it("no pool example while the pool is closed for the club", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).toContain(`📣 *Finding players*: "ask the group", "DM them"`);
  });
});

describe("(b) every line of the old full HQ help is in exactly one topic", () => {
  // The lines that stay in the menu (its heading, how to tag, how any part
  // works, anything else, "see this again"), or are blank.
  const menuLine = (l: string) =>
    l === "" || /^(🛠️|Tag me in every|Burada her mesajda|ℹ️|❓|Ask \*@Match Time what can you do|Bunu tekrar görmek)/u.test(l);

  it("for every club shape, EN and TR", () => {
    let checked = 0;
    for (const [key, full] of Object.entries(BEFORE)) {
      const { lang, gates } = gatesOf(key);
      const details = HQ_HELP_TOPICS.map((tp) => buildHqTopicLines(tp, { lang, ...gates }));
      for (const line of full.split("\n").filter((l) => !menuLine(l))) {
        const homes = HQ_HELP_TOPICS.filter((_, i) => details[i].split("\n").includes(line));
        expect(homes, `${key}: ${line}`).toHaveLength(1);
        checked++;
      }
      // And no topic says anything the old help did not say for that club.
      for (const [i, d] of details.entries()) {
        for (const l of d.split("\n").slice(1)) expect(full.split("\n"), `${key} ${HQ_HELP_TOPICS[i]}: ${l}`).toContain(l);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("the old menu's lines landed where the approved design puts them", () => {
    const at = (tp: (typeof HQ_HELP_TOPICS)[number], lang = "en") =>
      buildHqTopicLines(tp, { lang, squad: true, graphics: true, picks: true, paid: true, free: true, pool: true });
    expect(at("squad")).toContain("paste the whole squad list");
    expect(at("squad")).toContain("swap Tom for Ben");
    expect(at("teams")).toContain("use these");
    expect(at("teams")).toContain("make the proposed teams final");
    expect(at("players")).toContain("ask the group if anyone can play");
    expect(at("players")).toContain("DM them");
    expect(at("players")).toContain("ask the player pool for 2 players");
    expect(at("players")).toContain("pick who plays");
    expect(at("game")).toContain("cancel Friday");
    expect(at("game")).toContain("make it 8 a side");
    expect(at("game")).toContain("move Monday's game to 20:15");
    expect(at("settings")).toContain("quiet hours");
    expect(at("settings")).toContain("we play with 12 to 16");
    expect(at("graphics")).toContain("send the poster");
    expect(at("payments")).toContain("PAID ALL");
    expect(at("payments")).toContain("Bilal is free this week");
  });
});

describe("(c) the players' menu is short, and what it dropped is in a topic", () => {
  const CTX = [
    { audience: "group" as const },
    { audience: "player" as const },
    { audience: "admin" as const, links: { settings: "https://x/s" }, adminGroupLinked: true },
    { audience: "admin" as const, dm: true, links: { settings: "https://x/s" } },
  ];
  it("at most 12 lines for every shape, audience and language", () => {
    for (const [name, f] of Object.entries(SHAPES))
      for (const lang of ["en", "tr"])
        for (const ctx of CTX) {
          const menu = buildHelpReply(null, f, lang, ctx);
          expect(lineCount(menu), `${name} ${lang} ${ctx.audience}\n${menu}`).toBeLessThanOrEqual(12);
        }
  });

  it("each line the old menu had and the new one does not is said by its topic", () => {
    // The old how-to lines (strings onbHowToUseMe), by what each said, and
    // the topic that now says it, in that topic's own words.
    const moved: Array<[string, "availability" | "friend" | "mom" | "ratings" | "reminders" | "payments", RegExp]> = [
      ["maybe: a DM ~24h before", "availability", /maybe[\s\S]*24h before/],
      ["bringing a friend", "friend", /my friend Ali is coming/],
      ["MoM announced in the group", "mom", /announce the winner in the group/],
      ["the rating link by DM", "ratings", /DM every player who turned out a private link/],
      ["a reminder in your own words", "reminders", /remind me Thursday/],
      ["the pay link by DM", "payments", /DM everyone who played a private link to pay/],
    ];
    for (const [what, topic, said] of moved) expect(buildHelpReply(topic, ALL_ON, "en"), what).toMatch(said);
    const menu = buildHelpReply(null, ALL_ON, "en");
    for (const kept of [/Say \*In\* or \*Out\*/, /type \*@\*, pick \*Match Time\*/, /banter/, /profile page/, /or anything else/]) expect(menu).toMatch(kept);
  });

  it("the players' menu, word for word, for a player in a club with everything on", () => {
    expect(buildHelpReply(null, ALL_ON, "en", { audience: "group" })).toBe(
      [
        `ℹ️ *MatchTime help*`,
        `✅ Say *In* or *Out* in the group for the next game, no need to tag me. Not sure? Say *maybe*.`,
        `💬 Tag me (type *@*, pick *Match Time*) and ask in your own words: who's in, the teams, the stats or anything else. Typing my name or replying to my message is not enough.`,
        `🤐 I don't reply to banter and jokes, so they're safe.`,
        `📊 Your own profile page shows your games, ratings and Man of the Match awards: https://matchtime.ai/profile`,
        `ℹ️ To learn more about anything, tag me with *help* and the topic, for example *@Match Time help payments*. Topics: availability, friend, teams, mom, ratings, badges, reminders, payments, partners, pool, schedule, settings.`,
      ].join("\n"),
    );
  });

  it("Turkish, the same", () => {
    const menu = buildHelpReply(null, ALL_ON, "tr", { audience: "group" });
    expect(menu.split("\n")[0]).toBe(`ℹ️ *MatchTime yardım*`);
    expect(menu).toContain(`✅ Sıradaki maç için grupta *varım* ya da *yokum* yazın`);
    expect(menu).toContain(`örneğin *@Match Time yardım ödeme*. Konular: kadro, arkadaş, takımlar,`);
  });

  it("by DM: no tag in the examples", () => {
    const menu = buildHelpReply(null, ALL_ON, "en", { audience: "player", dm: true });
    expect(menu).toContain(`message me *help* and the topic, for example *help payments*`);
  });
});

describe("(e) the features a club has not switched on", () => {
  it("FNF (no match fees, no partner clubs, the pool closed): the HQ menu names them, as available", () => {
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: true, paid: false, features: FNF });
    expect(menu).toContain(
      `💡 *Not on here yet*: match fees, partner clubs, the player pool. Ask *@Match Time help payments* to see how they work and how to switch them on.`,
    );
    const tr = buildHqHelp({ lang: "tr", squad: true, graphics: true, picks: true, paid: false, features: FNF });
    expect(tr).toContain(`💡 *Burada henüz açık değil*: maç ücretleri, partner kulüpler, oyuncu havuzu. Nasıl çalıştıklarını ve nasıl açıldıklarını görmek için *@Match Time yardım ödeme* yazın.`);
  });

  it("everything on: no not-on line", () => {
    for (const lang of ["en", "tr"]) {
      expect(buildHqHelp({ lang, squad: true, graphics: true, picks: false, paid: false, pool: true, features: ALL_ON })).not.toContain("💡");
      expect(buildHelpReply(null, ALL_ON, lang, { audience: "admin" })).not.toContain("💡");
    }
  });

  it("an organiser's players' menu names them too; a player's does not nag (the topic list still has them)", () => {
    expect(buildHelpReply(null, FNF, "en", { audience: "admin" })).toContain("💡 *Not on here yet*: match fees, partner clubs, the player pool.");
    const player = buildHelpReply(null, FNF, "en", { audience: "group" });
    expect(player).not.toContain("💡");
    expect(player).toMatch(/Topics: .*payments, partners, pool/);
  });

  it("a pool the platform has closed is neither offered nor listed", () => {
    const closed: HelpFeatures = { ...FNF, pool: { open: false, platformOpen: false, clubFlag: false } };
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, features: closed });
    expect(menu).not.toContain("player pool");
    expect(menu).not.toMatch(/Topics: .*pool/);
  });

  it("'help payments' while payments are off: how it works and how to switch it on, then the way back", async () => {
    const reply = await hqHelpTopicReply({
      orgId: "org-1",
      lang: "en",
      gates: { squad: true, graphics: true, picks: false, paid: false, free: false, pool: false },
      req: { topic: "payments" },
      features: orgFeatures({ paymentCollection: false }),
      club: { pool: FNF.pool!, partners: FNF.partners! },
    });
    expect(reply).toContain("This isn't switched on for this group yet");
    expect(reply).toContain("Match fees: how it works");
    expect(reply).toContain("To switch it on");
    expect(reply.split("\n").at(-1)).toBe(`↩️ *@Match Time help* for the menu.`);
  });
});

function orgFeatures(over: Partial<OrgFeatures> = {}): OrgFeatures {
  return {
    botEnabled: true,
    attendance: true,
    bench: true,
    teamBalancing: true,
    momVoting: true,
    playerRating: true,
    reminders: true,
    statsQa: true,
    paymentTracking: false,
    paymentCollection: true,
    language: "en",
    benchPickMode: "first-come",
    ...over,
  } as OrgFeatures;
}

describe("(d) a topic request reaches its detail", () => {
  it("every extractor feature has a home in HQ: its own lines or the players' explainer", () => {
    expect(HELP_FEATURES).toContain("find_players");
    expect(HELP_FEATURES).toContain("graphics");
    expect(hqTopicFor("availability")).toBe("squad");
    expect(hqTopicFor("teams")).toBe("teams");
    expect(hqTopicFor("find_players")).toBe("players");
    expect(hqTopicFor("schedule")).toBe("game");
    expect(hqTopicFor("settings")).toBe("settings");
    expect(hqTopicFor("graphics")).toBe("graphics");
    expect(hqTopicFor("payments")).toBe("payments");
    for (const f of ["mom", "ratings", "reminders", "badges", "partners", "pool", "friend"] as const) expect(hqTopicFor(f)).toBeNull();
  });

  function stub(feature: string): PipelineModel {
    return {
      name: "stub",
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        return {
          text: JSON.stringify({ topic: "how_it_works", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature, badge: "none" }),
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
  }
  const CLUB: HelpClubFacts = { pool: { open: true, platformOpen: true, clubFlag: true }, partners: { active: 0 } };
  const GATES: HqHelpGates = { squad: true, graphics: true, picks: true, paid: false, free: true, pool: true };
  async function ask(feature: string, lang = "en") {
    const st = world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
    return answerHqQuestion({
      orgId: "org-1",
      lang,
      messageId: "wa-9",
      body: `@Match Time help ${feature}`,
      senderUserId: "u-kemal",
      senderName: "Kemal Ediz",
      now: NOW,
      history: [],
      lastBotPost: null,
      gates: GATES,
      deps: {
        model: stub(feature),
        loadState: async () => st,
        loadFeatures: async () => orgFeatures({ language: lang as "en" }),
        loadClub: async () => ({ collectorName: "Elvin Aliyev", feePerPlayer: 5, feeSplitTotal: false, teamsReady: "10:00" }),
        loadClubFacts: async () => CLUB,
      },
    });
  }

  it("help players: the finding-players lines, then the way back", async () => {
    const r = await ask("find_players");
    expect(r?.outcome).toBe("hq-help");
    expect(r?.replyText).toContain(buildHqTopicLines("players", { lang: "en", ...GATES }));
    expect(r?.replyText.split("\n").at(-1)).toBe(`↩️ *@Match Time help* for the menu.`);
  });

  it("help teams: the team lines, then how the teams are made", async () => {
    const r = await ask("teams");
    expect(r?.replyText).toContain(buildHqTopicLines("teams", { lang: "en", ...GATES }));
    expect(r?.replyText).toContain("Fair teams: how it works");
  });

  it("help game: the game lines, then the schedule, without the line the admin group makes untrue", async () => {
    const r = await ask("schedule");
    expect(r?.replyText).toContain(buildHqTopicLines("game", { lang: "en", ...GATES }));
    expect(r?.replyText).toContain("Block booking");
    expect(r?.replyText).not.toContain("can't be moved on its own");
  });

  it("help graphics and help settings, EN and TR", async () => {
    expect((await ask("graphics"))?.replyText).toContain("send the poster");
    expect((await ask("settings"))?.replyText).toContain("quiet hours");
    expect((await ask("graphics", "tr"))?.replyText).toContain("posteri gönder");
    expect((await ask("settings", "tr"))?.replyText.split("\n").at(-1)).toBe(`↩️ Menü için *@Match Time yardım* yazın.`);
  });

  it("help pool: the players' explainer, worded for the organisers", async () => {
    const r = await ask("pool");
    expect(r?.replyText).toMatch(/player pool/i);
    expect(r?.replyText.split("\n").at(-1)).toBe(`↩️ *@Match Time help* for the menu.`);
  });

  it("the bare menu: the short HQ menu, built from the club's settings", async () => {
    const r = await ask("none");
    expect(r?.outcome).toBe("hq-help");
    expect(r?.replyText.startsWith("🛠️ *MatchTime in your admin group*")).toBe(true);
    expect(lineCount(r!.replyText)).toBeLessThanOrEqual(12);
  });

  it("the players' group and DMs read the admin group's two topics as the nearest players' one", async () => {
    const club = async () => ({});
    const f = orgFeatures();
    const players = await clubHelpReply({ orgId: "org-1", req: { topic: "find_players" }, features: f, audience: "group", poolEnv: club, club: CLUB });
    expect(players).toContain("Squad & availability: how it works");
    const graphics = await clubHelpReply({ orgId: "org-1", req: { topic: "graphics" }, features: f, audience: "group", poolEnv: club, club: CLUB });
    expect(graphics).toContain("Fair teams: how it works");
  });
});

describe("(f) every topic ends with the way back to the menu", () => {
  it("in a group and by DM, EN and TR", async () => {
    const env = async () => ({});
    for (const lang of ["en", "tr"] as const) {
      const f = orgFeatures({ language: lang });
      const group = await clubHelpReply({ orgId: "o", req: { topic: "mom" }, features: f, audience: "group", poolEnv: env, club: { pool: FNF.pool!, partners: FNF.partners! } });
      const dm = await clubHelpReply({ orgId: "o", req: { topic: "mom" }, features: f, audience: "player", poolEnv: env, dm: true, club: { pool: FNF.pool!, partners: FNF.partners! } });
      expect(group.split("\n").at(-1)).toBe(lang === "en" ? `↩️ *@Match Time help* for the menu.` : `↩️ Menü için *@Match Time yardım* yazın.`);
      expect(dm.split("\n").at(-1)).toBe(lang === "en" ? `↩️ *help* for the menu.` : `↩️ Menü için *yardım* yazın.`);
      const menu = await clubHelpReply({ orgId: "o", req: { topic: null }, features: f, audience: "group", poolEnv: env, club: { pool: FNF.pool!, partners: FNF.partners! } });
      expect(menu).not.toContain("↩️");
    }
  });

  it("house rules: no em or en dash, no slash as a separator, never 'waiting list'", () => {
    const outs: string[] = [];
    for (const key of Object.keys(BEFORE)) {
      const { lang, gates } = gatesOf(key);
      for (const f of Object.values(SHAPES)) outs.push(buildHqHelp({ lang, ...gates, features: f }));
      for (const tp of HQ_HELP_TOPICS) outs.push(buildHqTopicLines(tp, { lang, ...gates }));
    }
    for (const [, f] of Object.entries(SHAPES)) for (const lang of ["en", "tr"]) outs.push(buildHelpReply(null, f, lang, { audience: "admin" }));
    for (const o of outs) {
      expect(o).not.toMatch(/[—–]/);
      expect(o).not.toMatch(/waiting list|bekleme listesi/i);
      expect(o.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\w ?\/ ?\w/);
    }
  });
});
