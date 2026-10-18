/**
 * HELP FOR A CLUB WHOSE ORGANISERS ANNOUNCE (2026-10-15).
 *
 * `Organisation.listAnnouncer = "organisers"` (list-announcer.ts): the
 * organisers share the list and the teams themselves, and MatchTime posts
 * neither in the players' group. What that does to a main-chat question,
 * traced in code:
 *
 *   - "who's playing?" / "how many?": the composer says
 *     `oa_list_by_organisers` for the squad (pipeline/compose.ts), and the
 *     route's last pass (`organisersGroupReply`, analyze/route.ts) turns any
 *     reply that shows squad state, the count line included, into the same
 *     sentence. Pinned below on the real count copy.
 *   - "show the teams": `teams_post` / `teams_not_generated` become
 *     `oa_teams_by_organisers` (compose.ts).
 *   - "generate the teams": the team sheet reply shows numbered lines, so
 *     the same last pass turns it into `oa_list_by_organisers`. Pinned below.
 *   - a place opening goes to the organisers, not the group (compose.ts
 *     `slot_opened` -> adminNotices), and a format switch's new line-up is
 *     relayed to them (actions/matches.ts).
 *   - `benchPickMode = "organiser"`: no bench offer on a drop
 *     (`requestBenchConfirmationOnDrop` returns at once); the organisers
 *     pick (`organiser-pick.ts`).
 *
 * So the help must not promise any of those, and a club on the defaults
 * must get exactly what it got before (the fixture was recorded from the
 * builder BEFORE this change).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildHelpReply, helpFeaturesFrom, type HelpFeatures, type HelpTopic } from "@/lib/onboarding-conversation";
import { organisersGroupReply } from "@/lib/organisers-list-copy";
import { formatTeamsPost } from "@/lib/group-copy";
import { t } from "@/lib/i18n/t";

const BEFORE: Record<string, string> = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/help-before-organisers.json"), "utf8"),
);

const ALL_ON: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
  paymentCollection: true,
};
const FEATURE_SETS: Record<string, HelpFeatures> = {
  allOn: ALL_ON,
  allOff: {
    attendance: false,
    teamBalancing: false,
    momVoting: false,
    playerRating: false,
    statsQa: false,
    reminders: false,
    bench: false,
    paymentTracking: false,
    paymentCollection: false,
  },
  noTeamsNoPay: {
    attendance: true,
    teamBalancing: false,
    momVoting: true,
    playerRating: false,
    statsQa: true,
    reminders: false,
    bench: true,
    paymentTracking: false,
    paymentCollection: false,
  },
};
const LINKS = { settings: "https://x/s", activities: "https://x/a", blockBookings: "https://x/b", bulk: "https://x/u", matches: "https://x/m" };
const TOPICS: (HelpTopic | null)[] = [null, "availability", "teams", "mom", "ratings", "reminders", "payments", "schedule", "badges"];

const FNF: HelpFeatures = { ...ALL_ON, organisersAnnounce: true, organiserPicks: true };

describe("a club on the defaults: byte for byte what it got before", () => {
  it("every topic, language, audience and feature set matches the recorded output", () => {
    let n = 0;
    for (const [fk, f] of Object.entries(FEATURE_SETS)) {
      for (const lang of ["en", "tr"]) {
        for (const audience of ["group", "admin", "player"] as const) {
          for (const tp of TOPICS) {
            const key = `${fk}|${lang}|${audience}|${tp ?? "bare"}`;
            const ctx = { audience, links: audience === "admin" ? LINKS : undefined };
            // The flags absent, explicitly off, and read off a club row on the defaults.
            const fromRow = helpFeaturesFrom({ ...f, paymentCollection: f.paymentCollection === true, listAnnouncer: "matchtime", benchPickMode: "first-come" });
            for (const feats of [f, { ...f, organisersAnnounce: false, organiserPicks: false }, fromRow]) {
              expect(buildHelpReply(tp, feats, lang, ctx), key).toBe(BEFORE[key]);
              n++;
            }
            // Linking an admin group changes nothing for a club on the defaults.
            expect(buildHelpReply(tp, f, lang, { ...ctx, adminGroupLinked: true }), key).toBe(BEFORE[key]);
          }
        }
      }
    }
    expect(n).toBe(162 * 3);
  });
});

describe("helpFeaturesFrom reads the two settings", () => {
  const row = { ...ALL_ON, paymentCollection: true };
  it("organisers + organiser pick", () => {
    expect(helpFeaturesFrom({ ...row, listAnnouncer: "organisers", benchPickMode: "organiser" })).toMatchObject({
      organisersAnnounce: true,
      organiserPicks: true,
    });
  });
  it("anything else reads as off", () => {
    expect(helpFeaturesFrom({ ...row, listAnnouncer: "matchtime", benchPickMode: "first-come" })).toMatchObject({
      organisersAnnounce: false,
      organiserPicks: false,
    });
    expect(helpFeaturesFrom(row)).toMatchObject({ organisersAnnounce: false, organiserPicks: false });
  });
});

describe("the trace the copy is written against", () => {
  it("a count answer in the players' group becomes 'the organisers will post the list'", () => {
    for (const lang of ["en", "tr"] as const) {
      const count = t(lang).answer_count({ stated: false, confirmed: 11, maxPlayers: 18, kickoffLabel: "Fri 20:30", need: 7, bench: "" });
      expect(organisersGroupReply(count, lang)).toBe(t(lang).oa_list_by_organisers);
      const full = t(lang).answer_count({ stated: false, confirmed: 18, maxPlayers: 18, kickoffLabel: "Fri 20:30", need: 0, bench: "" });
      expect(organisersGroupReply(full, lang)).toBe(t(lang).oa_list_by_organisers);
    }
  });
  it("the availability explainer's heading reads as squad state to that same net, so the route must not run help through it", () => {
    // `displaysSquadState` header rule: "*Squad ...*" / "*Kadro ...*". Before
    // this change FNF's "@Match Time help availability" was answered "The
    // organisers will post the list." (analyze/route.ts now skips help).
    for (const lang of ["en", "tr"] as const) {
      expect(organisersGroupReply(buildHelpReply("availability", FNF, lang), lang)).toBe(t(lang).oa_list_by_organisers);
      expect(organisersGroupReply(BEFORE[`allOn|${lang}|group|availability`], lang)).toBe(t(lang).oa_list_by_organisers);
    }
  });

  it("a generated team sheet in the players' group becomes 'the organisers will post the list'", () => {
    for (const lang of ["en", "tr"] as const) {
      const sheet = formatTeamsPost({
        redLabel: "Red",
        yellowLabel: "Yellow",
        red: [{ name: "Sam" }, { name: "Alex" }],
        yellow: [{ name: "Tom" }, { name: "Ben" }],
        kickoff: "20:30",
        venue: "Goals",
        lang,
      });
      expect(organisersGroupReply(sheet, lang)).toBe(t(lang).oa_list_by_organisers);
    }
  });
});

const FORBIDDEN_EN = [
  /make \/ show the teams/,
  /see who's in/,
  /I post the line-ups/,
  /generate the teams/,
  /show the teams/,
  /nudge the bench/,
  /in order/,
  /remind the whole squad/,
  /I post the new line-up in the group/,
];
const FORBIDDEN_TR = [
  /takımları kur/,
  /takımları göster/,
  /kim var \/ kaç kişiyiz/,
  /Kadroları doğrudan gruba yazarım/,
  /yedekleri dürterim/,
  /sırayla/,
  /bütün kadroya hatırlatırım/,
  /Yeni kadroyu gruba ben yazarım/,
];

describe("organisers mode, main chat (FNF: organisers announce, organisers pick)", () => {
  it("nothing in any group help promises a squad post, a team sheet, team building or a bench nudge", () => {
    for (const tp of TOPICS) {
      const en = buildHelpReply(tp, FNF, "en", { audience: "group" });
      const tr = buildHelpReply(tp, FNF, "tr", { audience: "group" });
      for (const re of FORBIDDEN_EN) expect(en, `${tp} en ${re}`).not.toMatch(re);
      for (const re of FORBIDDEN_TR) expect(tr, `${tp} tr ${re}`).not.toMatch(re);
      for (const s of [en, tr]) expect(s).not.toMatch(/[—–]/);
    }
  });

  it("bare help, English", () => {
    expect(buildHelpReply(null, FNF, "en", { audience: "group" })).toBe(
      [
        `ℹ️ *MatchTime help*: here's what I can explain. Tag me with one of these:`,
        `   • *@Match Time help availability*: squad & availability`,
        `   • *@Match Time help teams*: fair teams`,
        `   • *@Match Time help mom*: Man of the Match`,
        `   • *@Match Time help ratings*: player ratings`,
        `   • *@Match Time help badges*: badges and how to earn them`,
        `   • *@Match Time help reminders*: reminders`,
        `   • *@Match Time help payments*: match fees`,
        `   • *@Match Time help schedule*: schedule & bookings`,
        ``,
        `✅ Say *"In"* or *"Out"* to mark your own availability, no need to tag me.`,
        `🤔 Not sure? Just say *"maybe"* and I'll check with you ~24h before.`,
        `📣 The organisers share the squad list and the teams. I keep track of who's in and out for them.`,
        `💬 Tag *@Match Time* when you want me to do or tell you something:`,
        `   • who won last week? / past stats`,
        `🤐 I stay quiet the rest of the time: banter and jokes are safe, I won't butt in.`,
        `🏆 After the game I'll run a quick *Man of the Match* vote.`,
        `⭐ I'll DM you a one-tap *rating* link after the match.`,
        `⏰ Need a nudge? Say *"@Match Time remind me Thursday"* and I'll DM you then.`,
        `💷 After each game I'll DM you a link to pay your match fee.`,
        `💳 I keep track of who's *paid*.`,
        ``,
        `Type *"@Match Time help"* any time to see this again.`,
      ].join("\n"),
    );
  });

  it("bare help, Turkish", () => {
    const tr = buildHelpReply(null, FNF, "tr", { audience: "group" });
    expect(tr).toContain(`📣 Kadro listesini ve takımları organizatörler paylaşır. Kimin var kimin yok olduğunu onlar için ben takip ederim.`);
    expect(tr).toContain(`   • geçen hafta kim kazandı? / eski istatistikler`);
    expect(tr).not.toContain(`kim var / kaç kişiyiz`);
  });

  it("with stats off there is nothing to tag me for, and no empty 'tag me' heading", () => {
    const f = { ...FNF, statsQa: false };
    expect(buildHelpReply(null, f, "en", { audience: "group" })).not.toContain(`💬 Tag *@Match Time*`);
    expect(buildHelpReply(null, f, "tr", { audience: "group" })).not.toContain(`💬 Bir şey yapmamı`);
  });

  it("with attendance off it does not claim to keep track of who's in", () => {
    const en = buildHelpReply(null, { ...FNF, attendance: false }, "en", { audience: "group" });
    expect(en).toContain(`📣 The organisers share the squad list and the teams.\n`);
    expect(en).not.toContain(`I keep track of who's in and out`);
  });

  it("help teams: the organisers share them; English and Turkish", () => {
    const en = `🟥🟦 *Teams: how it works*\nThe organisers sort out the teams and share them with the group themselves, so I don't post team sheets in this chat.\nKeep an eye out for their post before the game.`;
    const tr = `🟥🟦 *Takımlar nasıl çalışır*\nTakımları organizatörler ayarlar ve grupla kendileri paylaşır, bu yüzden bu sohbete takım listesi yazmam.\nMaçtan önce onların paylaşımını takip edin.`;
    expect(buildHelpReply("teams", FNF, "en", { audience: "group" })).toBe(en);
    expect(buildHelpReply("teams", FNF, "tr", { audience: "group" })).toBe(tr);
    // Team generation off makes no difference: it is still the organisers' job, not a feature to switch on.
    expect(buildHelpReply("teams", { ...FNF, teamBalancing: false }, "en", { audience: "group" })).toBe(en);
    // An organiser by DM also gets where the settings are.
    expect(buildHelpReply("teams", FNF, "en", { audience: "admin", links: LINKS })).toBe(`${en}\n\n⚙️ Its settings are on your admin page:\nhttps://x/s`);
  });

  it("help availability, organisers pick: English and Turkish", () => {
    expect(buildHelpReply("availability", FNF, "en", { audience: "group" })).toBe(
      `⚽ *Squad & availability: how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
        `I keep track of who's in for the organisers, and they share the list with the group. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `When the squad is full, say *In* to go on the bench. When a place opens, the organisers pick who plays. Say *Out* any time if you can't make it.`,
    );
    expect(buildHelpReply("availability", FNF, "tr", { audience: "group" })).toBe(
      `⚽ *Kadro ve katılım nasıl çalışır*\n` +
        `Bir sonraki maç için grupta *varım* veya *yokum* yazmanız yeter, beni etiketlemenize gerek yok, otomatik okurum.\n` +
        `Kimin geldiğini organizatörler için ben takip ederim, listeyi grupla onlar paylaşır. Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce özelden kesin cevabınızı sorarım.\n` +
        `Kadro doluysa yedeğe girmek için *varım* yazın. Bir yer açılınca kimin oynayacağını organizatörler seçer. Gelemeyecekseniz istediğiniz zaman *yokum* yazın.`,
    );
  });

  it("help availability, organisers announce but the bench is first come", () => {
    const f = { ...FNF, organiserPicks: false };
    expect(buildHelpReply("availability", f, "en", { audience: "group" })).toContain(
      `When the squad is full, extra players go on the *bench*, and the bench gets first go at any place that opens. Say *Out* any time if you can't make it.`,
    );
    expect(buildHelpReply("availability", f, "tr", { audience: "group" })).toContain(
      `Kadro dolunca sonra yazanlar *yedek* listesine girer, açılan bir yer için ilk şans yedeklerindir. Gelemeyecekseniz istediğiniz zaman *yokum* yazın.`,
    );
  });

  it("help reminders: the personal nudge stays, the squad updates go to the organisers", () => {
    expect(buildHelpReply("reminders", FNF, "en", { audience: "group" })).toBe(
      `⏰ *Reminders: how it works*\n` +
        `Want a personal nudge? Say *"@Match Time remind me Thursday"* and I'll DM you then.\n` +
        `Squad updates before the game go to the organisers, and they share the list with the group.`,
    );
    expect(buildHelpReply("reminders", FNF, "tr", { audience: "group" })).toBe(
      `⏰ *Hatırlatmalar nasıl çalışır*\n` +
        `Kişisel bir hatırlatma mı istiyorsunuz? *"@Match Time perşembe hatırlat"* yazın, o zaman size özelden yazarım.\n` +
        `Maçtan önceki kadro bilgileri organizatörlere gider, listeyi grupla onlar paylaşır.`,
    );
  });

  it("help schedule: a format switch's line-up goes to the organisers", () => {
    const en = buildHelpReply("schedule", FNF, "en", { audience: "group" });
    expect(en).toContain(`then *Confirm switch*. I send the new line-up to the organisers to share.\n`);
    const tr = buildHelpReply("schedule", FNF, "tr", { audience: "group" });
    expect(tr).toContain(`› *Confirm switch*. Yeni kadroyu paylaşmaları için organizatörlere gönderirim.\n`);
  });

  it("topics the setting does not touch are unchanged (MoM, ratings, payments, badges)", () => {
    for (const tp of ["mom", "ratings", "payments", "badges"] as const) {
      for (const lang of ["en", "tr"]) {
        expect(buildHelpReply(tp, FNF, lang, { audience: "group" })).toBe(BEFORE[`allOn|${lang}|group|${tp}`]);
      }
    }
  });
});

describe("organiser pick in a club MatchTime still announces for", () => {
  const f = { ...ALL_ON, organiserPicks: true };
  it("help availability says the organisers pick, not that I nudge the bench", () => {
    expect(buildHelpReply("availability", f, "en", { audience: "group" })).toBe(
      `⚽ *Squad & availability: how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
        `I keep a live, numbered squad list. When it's full, extra players go on the *bench*. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `When a place opens, the organisers pick who plays from the bench. Say *Out* any time if you can't make it.`,
    );
    expect(buildHelpReply("availability", f, "tr", { audience: "group" })).toBe(
      `⚽ *Kadro ve katılım nasıl çalışır*\n` +
        `Bir sonraki maç için grupta *varım* veya *yokum* yazmanız yeter, beni etiketlemenize gerek yok, otomatik okurum.\n` +
        `Numaralı ve güncel bir kadro listesi tutarım. Kadro dolunca sonra yazanlar *yedek* listesine girer. Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce özelden kesin cevabınızı sorarım.\n` +
        `Bir yer açılınca yedeklerden kimin oynayacağını organizatörler seçer. Gelemeyecekseniz istediğiniz zaman *yokum* yazın.`,
    );
  });
  it("every other topic is as before", () => {
    for (const tp of TOPICS.filter((x) => x !== "availability")) {
      for (const lang of ["en", "tr"]) {
        expect(buildHelpReply(tp, f, lang, { audience: "group" })).toBe(BEFORE[`allOn|${lang}|group|${tp ?? "bare"}`]);
      }
    }
  });
});

describe("an organiser's DM help in organisers mode", () => {
  const SECTION_EN = `📣 Your organisers share the list and the teams. In your admin group, type *help* and I'll show the commands I take there.`;
  const SECTION_TR = `📣 Listeyi ve takımları organizatörler paylaşıyor. Yönetici grubunda *yardım* yaz, orada kabul ettiğim komutları göstereyim.`;

  it("bare help adds the HQ pointer before the settings link (English)", () => {
    const out = buildHelpReply(null, FNF, "en", { audience: "admin", links: LINKS, adminGroupLinked: true });
    expect(out.endsWith(`\n\n${SECTION_EN}\n\n⚙️ Your club's settings, signed in:\nhttps://x/s`)).toBe(true);
  });

  it("and in Turkish", () => {
    const out = buildHelpReply(null, FNF, "tr", { audience: "admin", links: LINKS, adminGroupLinked: true });
    expect(out.endsWith(`\n\n${SECTION_TR}\n\n⚙️ Kulübünün ayarları, giriş yapmış olarak:\nhttps://x/s`)).toBe(true);
  });

  it("not without an admin group to type it in, and never for a player or in the group", () => {
    expect(buildHelpReply(null, FNF, "en", { audience: "admin", links: LINKS })).not.toContain(SECTION_EN);
    expect(buildHelpReply(null, FNF, "en", { audience: "player", adminGroupLinked: true })).not.toContain(SECTION_EN);
    expect(buildHelpReply(null, FNF, "en", { audience: "group", adminGroupLinked: true })).not.toContain(SECTION_EN);
  });
});

// FNF (2026-10-15): the players' group bare help ended, for a club with
// payments off, with "💷 Want to collect match fees? Ask me: *@Match Time
// help payments*". That line is for an organiser, yet every player in the
// main chat saw it. The group no longer gets it; an organiser's DM still
// does, and "help payments" asked outright still answers as before.
describe("the fee-collection nudge is for organisers, not the players' group", () => {
  const NUDGE_EN = `💷 Want to collect match fees? Ask me: *@Match Time help payments*`;
  const NUDGE_TR = `💷 Maç ücretlerini toplamak mı istiyorsunuz? Bana sorun: *@Match Time yardım ödeme*`;
  const PAY_OFF: HelpFeatures = { ...ALL_ON, paymentTracking: false, paymentCollection: false };
  const FNF_PAY_OFF: HelpFeatures = { ...FNF, paymentTracking: false, paymentCollection: false };

  it("group bare help with payments off: no nudge and no payments topic, in English and Turkish", () => {
    for (const f of [PAY_OFF, FNF_PAY_OFF, FEATURE_SETS.allOff, FEATURE_SETS.noTeamsNoPay]) {
      const en = buildHelpReply(null, f, "en", { audience: "group" });
      const tr = buildHelpReply(null, f, "tr", { audience: "group" });
      expect(en).not.toContain(NUDGE_EN);
      expect(tr).not.toContain(NUDGE_TR);
      expect(en).not.toMatch(/help payments/);
      expect(tr).not.toMatch(/yardım ödeme/);
      expect(en).not.toContain("💷");
      expect(tr).not.toContain("💷");
      // The closing line still follows the last feature line directly.
      expect(en.endsWith(`\n\nType *"@Match Time help"* any time to see this again.`)).toBe(true);
    }
  });

  it("a player's DM matches the group's (no nudge), in English and Turkish", () => {
    for (const lang of ["en", "tr"]) {
      expect(buildHelpReply(null, PAY_OFF, lang, { audience: "player" })).toBe(buildHelpReply(null, PAY_OFF, lang, { audience: "group" }));
    }
  });

  it("an organiser's DM keeps the nudge, in English and Turkish", () => {
    expect(buildHelpReply(null, PAY_OFF, "en", { audience: "admin", links: LINKS })).toContain(NUDGE_EN);
    expect(buildHelpReply(null, PAY_OFF, "tr", { audience: "admin", links: LINKS })).toContain(NUDGE_TR);
    expect(buildHelpReply(null, FNF_PAY_OFF, "en", { audience: "admin", links: LINKS, adminGroupLinked: true })).toContain(NUDGE_EN);
  });

  it("group bare help is otherwise the admin's text without the nudge line and the admin tail", () => {
    for (const lang of ["en", "tr"]) {
      const nudge = lang === "en" ? NUDGE_EN : NUDGE_TR;
      const group = buildHelpReply(null, PAY_OFF, lang, { audience: "group" });
      const admin = buildHelpReply(null, PAY_OFF, lang, { audience: "admin", links: LINKS });
      expect(admin.startsWith(group.replace(/\n\n(Type|Bunu)/, `\n${nudge}\n\n$1`))).toBe(true);
    }
  });

  it("'help payments' asked outright in the group still answers as before", () => {
    for (const lang of ["en", "tr"]) {
      expect(buildHelpReply("payments", PAY_OFF, lang, { audience: "group" })).toBe(BEFORE[`allOff|${lang}|group|payments`]);
    }
  });

  it("payments on: the group bare help is unchanged and lists the payments topic", () => {
    for (const lang of ["en", "tr"]) {
      expect(buildHelpReply(null, ALL_ON, lang, { audience: "group" })).toBe(BEFORE[`allOn|${lang}|group|bare`]);
    }
    expect(buildHelpReply(null, ALL_ON, "en", { audience: "group" })).toMatch(/• \*@Match Time help payments\*/);
  });
});
