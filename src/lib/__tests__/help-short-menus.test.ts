/**
 * HELP MENUS: A LIST OF TOPICS (Kemal, 2026-11-10: "I thought it would
 * display what help menu items are there with only one liner explanation
 * for each and if they wanna learn more they would just drill down further
 * by saying @Match Time help xxx").
 *
 * #591 made the menus short; now the bare menu in the players' group, the
 * admin group (HQ) and by DM is the topics, one line each, under a heading
 * that says how to drill down, and a last "anything else" line. Nothing
 * else: "@Match Time help <topic>" gives the rest.
 *
 *   (a) the HQ menu's shape, word for word, EN and TR, every club shape;
 *   (b) every line of the old full HQ help (recorded from the builder
 *       BEFORE #591, fixtures/hq-help-full-before-short-menu.json) is in
 *       exactly one HQ topic, for every club shape, so nothing is lost;
 *   (c) the players' and DM menu's shape; what the old menus said is said
 *       by its topic;
 *   (d) a topic request reaches its detail (stubbed model), and every word
 *       any menu lists is one #592's paid check verified and reaches its
 *       topic, EN and TR;
 *   (e) the features a club has NOT switched on carry "(off here)" on
 *       their own line, built from its settings, for the organisers;
 *   (f) each topic ends with the way back to the menu; house rules.
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
import { buildHelpReply, helpFeaturesFrom, type HelpFeatures, type HelpTopic } from "@/lib/onboarding-conversation";
import { readDmHelp } from "@/lib/dm-help";
import { t } from "@/lib/i18n/t";
import { clubHelpReply } from "@/lib/help-answer";
import { answerHqQuestion } from "@/lib/admin-group-question";
import type { OrgFeatures } from "@/lib/org-features";
import type { HelpClubFacts } from "@/lib/help-club-facts";
import type { ModelRequest, ModelResponse, PipelineModel } from "@/lib/pipeline/llm";
import { NOW, world } from "@/lib/pipeline/__tests__/helpers";
import { HELP_FEATURES, type HelpFeature } from "@/lib/pipeline/types";

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


/** A menu's topic lines: everything after the blank line but the last
 *  ("anything else") line. */
const topicLines = (menu: string) => {
  const lines = menu.split("\n");
  return lines.slice(lines.indexOf("") + 1, -1);
};
/** The topic word of a menu line ("📋 *squad*: ..." is "squad"). */
const wordOf = (line: string) => /^\S+ \*([^*]+)\*: /u.exec(line)![1];
/** A topic line: emoji, the topic word in bold, a one-liner (no quotes,
 *  no bold), and for an organiser maybe " (off here)". */
const TOPIC_LINE = /^\S+ \*[^*]+\*: [^*"]+$/u;

describe("(a) the HQ menu is a list of topics (Kemal, 2026-11-10: \"only one liner explanation for each\")", () => {
  it("heading, how to tag, how to drill down, a blank, one line per topic, anything else: EN and TR, every club shape", () => {
    let n = 0;
    for (const key of Object.keys(BEFORE)) {
      const { lang, gates } = gatesOf(key);
      for (const features of [undefined, ...Object.values(SHAPES)]) {
        const menu = buildHqHelp({ lang, ...gates, ...(features ? { features } : {}) });
        const lines = menu.split("\n");
        expect(lines[3], `${key}\n${menu}`).toBe("");
        expect(lines.at(-1)).toMatch(/^❓ /u);
        const topics = topicLines(menu);
        expect(lines).toHaveLength(5 + topics.length);
        for (const l of topics) expect(l, `${key}\n${menu}`).toMatch(TOPIC_LINE);
        n++;
      }
    }
    expect(n).toBe(48 * 5);
  });

  it("the approved menu, word for word, for a weekly club with the pool open and everything on", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, free: true, pool: true, features: ALL_ON })).toBe(
      [
        `🛠️ *MatchTime in your admin group*`,
        `Tag me in every message here: type *@* and pick *Match Time*.`,
        `Tag me with *help* and a topic to learn more, e.g. *@Match Time help teams*`,
        ``,
        `📋 *squad*: who's in, out or on the bench`,
        `🟥🟦 *teams*: making and changing the teams`,
        `📣 *players*: finding players when you're short`,
        `🗓️ *game*: cancel, resize or move a game`,
        `⚙️ *settings*: quiet hours, player numbers and the settings page`,
        `🖼️ *graphics*: the poster and the team sheet`,
        `💷 *payments*: match fees and who's paid`,
        `🤝 *partners*: players from partner clubs`,
        `🌍 *pool*: the MatchTime player pool`,
        `⭐ *mom*: Man of the Match`,
        `📈 *ratings*: player ratings after each game`,
        `⏰ *reminders*: what I remind players about`,
        `❓ Anything else: just tag me and ask`,
      ].join("\n"),
    );
  });

  it("Turkish, the same shape", () => {
    expect(buildHqHelp({ lang: "tr", squad: true, graphics: true, picks: false, paid: false, free: true, pool: true, features: ALL_ON })).toBe(
      [
        `🛠️ *Yönetici grubunda MatchTime*`,
        `Burada her mesajda beni etiketleyin: *@* yazıp *Match Time*'ı seçin.`,
        `Daha fazlası için beni *yardım* ve bir konuyla etiketleyin, örneğin *@Match Time yardım takımlar*`,
        ``,
        `📋 *kadro*: kim var, kim yok, kim yedekte`,
        `🟥🟦 *takımlar*: takımları kurmak ve değiştirmek`,
        `📣 *oyuncu bulma*: eksik kaldığınızda oyuncu bulmak`,
        `🗓️ *maç*: bir maçı iptal etmek, formatını ya da saatini değiştirmek`,
        `⚙️ *ayarlar*: sessiz saatler, oyuncu sayıları ve ayarlar sayfası`,
        `🖼️ *görseller*: poster ve takım listesi görseli`,
        `💷 *ödeme*: maç ücretleri ve kimin ödediği`,
        `🤝 *partner*: partner kulüplerden oyuncular`,
        `🌍 *havuz*: MatchTime oyuncu havuzu`,
        `⭐ *maçın adamı*: maçın adamı oylaması`,
        `📈 *puanlama*: her maçtan sonra oyuncu puanları`,
        `⏰ *hatırlatma*: oyunculara neleri hatırlattığım`,
        `❓ Başka bir şey: beni etiketleyip sormanız yeter`,
      ].join("\n"),
    );
  });

  it("a monthly club: no squad, teams or finding-players topic, the game without cancelling, and the example is a listed topic", () => {
    const menu = buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true, free: true, features: MONTHLY });
    expect(topicLines(menu).map(wordOf)).toEqual(["game", "settings", "graphics", "payments", "partners", "pool", "mom", "ratings", "reminders"]);
    expect(menu).toContain(`🗓️ *game*: resize or move a game`);
    expect(menu).toContain(`e.g. *@Match Time help game*`);
    expect(buildHqHelp({ lang: "tr", squad: false, graphics: true, picks: false, paid: true, features: MONTHLY })).toContain(
      `🗓️ *maç*: bir maçın formatını ya da saatini değiştirmek`,
    );
  });

  it("organiser pick on a monthly club keeps the finding-players topic (its pick replies)", () => {
    const menu = buildHqHelp({ lang: "en", squad: false, graphics: true, picks: true, paid: false, features: MONTHLY });
    expect(topicLines(menu).map(wordOf)).toContain("players");
  });

  it("no detail in the menu: the examples and commands are one topic away", () => {
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: true, paid: true, free: true, pool: true, features: ALL_ON });
    for (const gone of [`"put Bilal in"`, "send the poster", "quiet hours 23:00", "*YES*", "Topics:", "💡", "ℹ️ To learn more"]) expect(menu).not.toContain(gone);
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

describe("(c) the players' menu is a list of topics, and what it dropped is in a topic", () => {
  const CTX = [
    { audience: "group" as const },
    { audience: "player" as const },
    { audience: "admin" as const, links: { settings: "https://x/s" }, adminGroupLinked: true },
    { audience: "admin" as const, dm: true, links: { settings: "https://x/s" } },
  ];
  it("heading, how to drill down, a blank, one line per topic, anything else: every shape, audience and language", () => {
    for (const [name, f] of Object.entries(SHAPES))
      for (const lang of ["en", "tr"])
        for (const ctx of CTX) {
          const menu = buildHelpReply(null, f, lang, ctx);
          const lines = menu.split("\n");
          expect(lines[2], `${name} ${lang} ${ctx.audience}\n${menu}`).toBe("");
          expect(lines.at(-1)).toMatch(/^❓ /u);
          expect(lines).toHaveLength(4 + topicLines(menu).length);
          for (const l of topicLines(menu)) expect(l, `${name} ${lang} ${ctx.audience}\n${menu}`).toMatch(TOPIC_LINE);
        }
  });

  it("the lines the old menus had are said by their topics, not the menu", () => {
    // The old how-to lines (strings onbHowToUseMe and the #591 menu), by
    // what each said, and the topic that now says it, in its own words.
    const moved: Array<[string, "availability" | "friend" | "mom" | "ratings" | "reminders" | "payments", RegExp]> = [
      ["In or Out, no need to tag", "availability", /say \*In\* or \*Out\* in the group[\s\S]*No need to tag me/],
      ["maybe: a DM ~24h before", "availability", /maybe[\s\S]*24h before/],
      ["bringing a friend", "friend", /my friend Ali is coming/],
      ["MoM announced in the group", "mom", /announce the winner in the group/],
      ["the rating link by DM", "ratings", /DM every player who turned out a private link/],
      ["a reminder in your own words", "reminders", /remind me Thursday/],
      ["the pay link by DM", "payments", /DM everyone who played a private link to pay/],
    ];
    for (const [what, topic, said] of moved) expect(buildHelpReply(topic, ALL_ON, "en"), what).toMatch(said);
    const menu = buildHelpReply(null, ALL_ON, "en", { audience: "admin" });
    for (const gone of [/Say \*In\* or \*Out\*/, /banter/, /profile page/, /Topics:/, /💡/, /Your club's settings/]) expect(menu).not.toMatch(gone);
  });

  it("the approved players' menu, word for word, for a player in a club with everything on", () => {
    expect(buildHelpReply(null, ALL_ON, "en", { audience: "group" })).toBe(
      [
        `ℹ️ *MatchTime help*`,
        `Tag me with *help* and a topic to learn more, e.g. *@Match Time help teams*`,
        ``,
        `✅ *availability*: saying in, out or maybe`,
        `👫 *friend*: bringing a friend to play`,
        `🟥🟦 *teams*: how the teams are made`,
        `⭐ *mom*: Man of the Match`,
        `📈 *ratings*: rating each other after a game`,
        `🏅 *badges*: what your badges mean`,
        `⏰ *reminders*: what I remind you about`,
        `💷 *payments*: paying the match fee`,
        `🤝 *partners*: playing with partner clubs`,
        `🌍 *pool*: the player pool`,
        `📅 *schedule*: when and where you play`,
        `❓ Anything else: just tag me and ask`,
      ].join("\n"),
    );
  });

  it("Turkish, the same", () => {
    expect(buildHelpReply(null, ALL_ON, "tr", { audience: "group" })).toBe(
      [
        `ℹ️ *MatchTime yardım*`,
        `Daha fazlası için beni *yardım* ve bir konuyla etiketleyin, örneğin *@Match Time yardım takımlar*`,
        ``,
        `✅ *kadro*: varım, yokum ya da belki demek`,
        `👫 *arkadaş*: oynamaya arkadaş getirmek`,
        `🟥🟦 *takımlar*: takımlar nasıl kuruluyor`,
        `⭐ *maçın adamı*: maçın adamı oylaması`,
        `📈 *puanlama*: maçtan sonra birbirinizi puanlamak`,
        `🏅 *rozetler*: rozetleriniz ne anlama geliyor`,
        `⏰ *hatırlatma*: size neleri hatırlattığım`,
        `💷 *ödeme*: maç ücretini ödemek`,
        `🤝 *partner*: partner kulüplerle oynamak`,
        `🌍 *havuz*: oyuncu havuzu`,
        `📅 *program*: ne zaman ve nerede oynadığınız`,
        `❓ Başka bir şey: beni etiketleyip sormanız yeter`,
      ].join("\n"),
    );
  });

  it("an organiser also gets the settings topic; a player does not", () => {
    for (const lang of ["en", "tr"]) {
      const settings = lang === "en" ? `⚙️ *settings*: club settings and the settings page` : `⚙️ *ayarlar*: kulüp ayarları ve ayarlar sayfası`;
      const admin = topicLines(buildHelpReply(null, ALL_ON, lang, { audience: "admin" }));
      expect(admin.at(-1)).toBe(settings);
      expect(buildHelpReply(null, ALL_ON, lang, { audience: "group" })).not.toContain(settings);
      expect(buildHelpReply(null, ALL_ON, lang, { audience: "player", dm: true })).not.toContain(settings);
    }
  });

  it("by DM: no tag, the example is help payments", () => {
    const menu = buildHelpReply(null, ALL_ON, "en", { audience: "player", dm: true }).split("\n");
    expect(menu[1]).toBe(`Message me *help* and a topic to learn more, e.g. *help payments*`);
    expect(menu.at(-1)).toBe(`❓ Anything else: just ask`);
    const tr = buildHelpReply(null, ALL_ON, "tr", { audience: "player", dm: true }).split("\n");
    expect(tr[1]).toBe(`Daha fazlası için bana *yardım* ve bir konu yazın, örneğin *yardım ödeme*`);
    expect(tr.at(-1)).toBe(`❓ Başka bir şey: sormanız yeter`);
  });

  it("a monthly club's availability line says the month's list, not In or Out", () => {
    expect(buildHelpReply(null, MONTHLY, "en", { audience: "group" })).toContain(`✅ *availability*: who's on this month's list`);
    expect(buildHelpReply(null, MONTHLY, "tr", { audience: "group" })).toContain(`✅ *kadro*: bu ayın listesinde kimler var`);
  });
});

describe("(e) the features a club has not switched on: \"(off here)\" on their own line", () => {
  it("FNF (no match fees, no partner clubs, the pool closed): the HQ menu marks those three, EN and TR", () => {
    const en = topicLines(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: true, paid: false, features: FNF }));
    expect(en.filter((l) => l.endsWith(" (off here)"))).toEqual([
      `💷 *payments*: match fees and who's paid (off here)`,
      `🤝 *partners*: players from partner clubs (off here)`,
      `🌍 *pool*: the MatchTime player pool (off here)`,
    ]);
    const tr = topicLines(buildHqHelp({ lang: "tr", squad: true, graphics: true, picks: true, paid: false, features: FNF }));
    expect(tr.filter((l) => l.endsWith(" (burada kapalı)"))).toEqual([
      `💷 *ödeme*: maç ücretleri ve kimin ödediği (burada kapalı)`,
      `🤝 *partner*: partner kulüplerden oyuncular (burada kapalı)`,
      `🌍 *havuz*: MatchTime oyuncu havuzu (burada kapalı)`,
    ]);
  });

  it("every switched-off topic is marked, read from the club's settings, and nothing that is on", () => {
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, features: { ...FNF, momVoting: false, reminders: false } });
    expect(topicLines(menu).filter((l) => l.endsWith(" (off here)")).map(wordOf)).toEqual(["payments", "partners", "pool", "mom", "reminders"]);
  });

  it("everything on: no marker anywhere", () => {
    for (const lang of ["en", "tr"]) {
      expect(buildHqHelp({ lang, squad: true, graphics: true, picks: false, paid: false, pool: true, features: ALL_ON })).not.toMatch(/\((off here|burada kapalı)\)/);
      expect(buildHelpReply(null, ALL_ON, lang, { audience: "admin" })).not.toMatch(/\((off here|burada kapalı)\)/);
    }
  });

  it("an organiser's players' menu marks them too; a player's lists them without the marker", () => {
    const admin = topicLines(buildHelpReply(null, FNF, "en", { audience: "admin" }));
    expect(admin.filter((l) => l.endsWith(" (off here)")).map(wordOf)).toEqual(["payments", "partners", "pool"]);
    const dm = topicLines(buildHelpReply(null, FNF, "tr", { audience: "admin", dm: true }));
    expect(dm.filter((l) => l.endsWith(" (burada kapalı)")).map(wordOf)).toEqual(["ödeme", "partner", "havuz"]);
    const player = buildHelpReply(null, FNF, "en", { audience: "group" });
    expect(player).not.toContain("(off here)");
    expect(topicLines(player).map(wordOf)).toEqual(expect.arrayContaining(["payments", "partners", "pool"]));
  });

  it("a pool the platform has closed is neither offered nor listed", () => {
    const closed: HelpFeatures = { ...FNF, pool: { open: false, platformOpen: false, clubFlag: false } };
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, features: closed });
    expect(menu).not.toContain("player pool");
    expect(topicLines(menu).map(wordOf)).not.toContain("pool");
    expect(topicLines(buildHelpReply(null, closed, "en", { audience: "admin" })).map(wordOf)).not.toContain("pool");
  });

  it("the club's settings unread (a failed read): the HQ topics and payments, no marker", () => {
    const menu = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false });
    expect(topicLines(menu).map(wordOf)).toEqual(["squad", "teams", "players", "game", "settings", "graphics", "payments"]);
    expect(menu).not.toContain("(off here)");
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

  it("the bare menu: the HQ topic list, built from the club's settings", async () => {
    const r = await ask("none");
    expect(r?.outcome).toBe("hq-help");
    expect(r?.replyText.startsWith("🛠️ *MatchTime in your admin group*")).toBe(true);
    expect(topicLines(r!.replyText).map(wordOf)).toEqual([
      "squad", "teams", "players", "game", "settings", "graphics", "payments", "partners", "pool", "mom", "ratings", "reminders",
    ]);
  });

  // EVERY WORD A MENU LISTS REACHES ITS TOPIC (Kemal, 2026-11-10). The
  // words are the ones #592's paid check routed to the help and read as
  // their feature, players' group, HQ and DM, EN and TR, 78/78
  // (scripts/live-check-help-topics.ts PLAYERS_WORDS and HQ_WORDS).
  const PLAYERS_WORDS: Array<[string, string, HelpFeature]> = [
    ["availability", "kadro", "availability"],
    ["friend", "arkadaş", "friend"],
    ["teams", "takımlar", "teams"],
    ["mom", "maçın adamı", "mom"],
    ["ratings", "puanlama", "ratings"],
    ["badges", "rozetler", "badges"],
    ["reminders", "hatırlatma", "reminders"],
    ["payments", "ödeme", "payments"],
    ["partners", "partner", "partners"],
    ["pool", "havuz", "pool"],
    ["schedule", "program", "schedule"],
    ["settings", "ayarlar", "settings"],
  ];
  const HQ_WORDS: Array<[string, string, HelpFeature]> = [
    ["squad", "kadro", "availability"],
    ["teams", "takımlar", "teams"],
    ["players", "oyuncu bulma", "find_players"],
    ["game", "maç", "schedule"],
    ["settings", "ayarlar", "settings"],
    ["graphics", "görseller", "graphics"],
    ["payments", "ödeme", "payments"],
    ["partners", "partner", "partners"],
    ["pool", "havuz", "pool"],
    ["mom", "maçın adamı", "mom"],
    ["ratings", "puanlama", "ratings"],
    ["reminders", "hatırlatma", "reminders"],
  ];
  const featureOf = (table: Array<[string, string, HelpFeature]>, lang: string, word: string) =>
    table.find(([en, tr]) => (lang === "tr" ? tr : en) === word)?.[2];

  it("the word tables are the live check's own", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/live-check-help-topics.ts"), "utf8");
    for (const [en, tr, f] of [...PLAYERS_WORDS, ...HQ_WORDS]) expect(script).toContain(`["${en}", "${tr}", "${f}"]`);
  });

  it("every word every menu lists is a verified word: every shape, audience and language", () => {
    for (const lang of ["en", "tr"]) {
      for (const f of Object.values(SHAPES)) {
        for (const audience of ["group", "player", "admin"] as const) {
          for (const w of topicLines(buildHelpReply(null, f, lang, { audience })).map(wordOf)) expect(featureOf(PLAYERS_WORDS, lang, w), `${lang} ${w}`).toBeDefined();
        }
        for (const key of Object.keys(BEFORE).filter((k) => k.startsWith(`${lang}:`))) {
          for (const w of topicLines(buildHqHelp({ lang, ...gatesOf(key).gates, features: f })).map(wordOf)) expect(featureOf(HQ_WORDS, lang, w), `${lang} ${w}`).toBeDefined();
        }
      }
    }
  });

  it("each word the HQ menu lists, EN and TR, answers that topic's detail (stubbed model)", async () => {
    for (const lang of ["en", "tr"]) {
      const menu = buildHqHelp({ lang, ...GATES, features: ALL_ON });
      const words = topicLines(menu).map(wordOf);
      expect(words).toHaveLength(12);
      for (const w of words) {
        const feature = featureOf(HQ_WORDS, lang, w)!;
        const r = await ask(feature, lang);
        expect(r?.outcome, `${lang} ${w}`).toBe("hq-help");
        const reply = r!.replyText;
        expect(reply, `${lang} ${w}`).not.toContain(menu.split("\n")[0]);
        expect(reply.split("\n").at(-1)).toBe(lang === "en" ? `↩️ *@Match Time help* for the menu.` : `↩️ Menü için *@Match Time yardım* yazın.`);
        const hq = hqTopicFor(feature);
        if (hq) expect(reply, `${lang} ${w}`).toContain(buildHqTopicLines(hq, { lang, ...GATES }));
      }
    }
  });

  it("each word the players' and DM menus list, EN and TR, answers that topic (stubbed model)", async () => {
    const env = async () => ({});
    for (const lang of ["en", "tr"] as const) {
      const f = orgFeatures({ language: lang });
      for (const dm of [false, true]) {
        const menu = await clubHelpReply({ orgId: "o", req: { topic: null }, features: f, audience: "admin", poolEnv: env, club: CLUB, dm });
        for (const w of topicLines(menu).map(wordOf)) {
          const feature = featureOf(PLAYERS_WORDS, lang, w)!;
          const req = await readDmHelp({ text: `help ${w}`, authorName: "Kemal", now: NOW, model: stub(feature) });
          expect(req, `${lang} ${w}`).toEqual({ topic: feature });
          const reply = await clubHelpReply({ orgId: "o", req: req!, features: f, audience: "admin", poolEnv: env, club: CLUB, dm });
          const back = t(lang).help_back({ dm });
          expect(reply, `${lang} ${w}`).toBe(`${buildHelpReply(feature as HelpTopic, helpFeaturesFrom(f, CLUB), lang, { audience: "admin", ...(dm ? { dm: true } : {}) })}\n\n${back}`);
        }
      }
    }
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
