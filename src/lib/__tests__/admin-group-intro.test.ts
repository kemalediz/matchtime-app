/**
 * THE ADMIN GROUP INTRODUCTION (2026-10-15): the pure builder.
 *
 * Posted once when a club's admin group is linked (in place of the bare
 * "Linked as the admin group" line), and by `scripts/send-hq-intro.ts` for
 * a group linked before this existed. Every line follows the club's own
 * settings; which code backs each one is in `admin-group-help.ts`.
 *
 * The help and the intro read the SAME gates (`hqHelpGates`), so they can
 * never disagree about what HQ takes.
 */
import { describe, expect, it } from "vitest";
import { buildAdminGroupIntro, buildHqHelp, hqHelpGates, type AdminGroupIntroClub } from "@/lib/admin-group-help";

/** FNF as configured on 2026-10-15: organisers announce, organisers pick,
 *  weekly (rolling squad on), teams-ready time not set, live, Fridays. */
const FNF: AdminGroupIntroClub = {
  name: "FNF",
  language: "en",
  whatsappBotEnabled: true,
  squadMode: "weekly",
  benchPickMode: "organiser",
  listAnnouncer: "organisers",
  teamsReadyTime: null,
  featureAttendance: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  activityDays: [5],
};

/** A club on every default: MatchTime announces, first come, no teams time. */
const DEFAULT_CLUB: AdminGroupIntroClub = {
  name: "Harbour FC",
  language: "en",
  whatsappBotEnabled: true,
  squadMode: "weekly",
  benchPickMode: "first-come",
  listAnnouncer: "matchtime",
  teamsReadyTime: null,
  featureAttendance: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  activityDays: [2],
};

describe("buildAdminGroupIntro, English", () => {
  it("FNF (organisers announce, organisers pick, weekly, teams ready not set: 10:00)", () => {
    expect(buildAdminGroupIntro(FNF)).toBe(
      [
        `👋 I'm MatchTime, I'll help run *FNF*'s Fridays.`,
        `I keep track of who's *IN* and *OUT* in the main chat, build balanced teams here at 10:00 on match day for you to check, make the poster and team sheet, and run Man of the Match and ratings after the game.`,
        `The squad list and the teams stay here for you to share with the players.`,
        `When a place opens and someone is waiting, I ask here who plays.`,
        `Notices meant only for the organisers come here instead of by DM, and so does the rating notice, for you to pass on to the players.`,
        ``,
        `Nothing I say here goes to the players. Type *help* here any time to see what I take.`,
      ].join("\n"),
    );
  });

  it("a club on the defaults: MatchTime posts the list in the main chat, no teams time, no picks, no relay", () => {
    expect(buildAdminGroupIntro(DEFAULT_CLUB)).toBe(
      [
        `👋 I'm MatchTime, I'll help run *Harbour FC*'s Tuesdays.`,
        `I keep track of who's *IN* and *OUT* in the main chat, make the poster and team sheet, and run Man of the Match and ratings after the game.`,
        `I post the squad list in the main chat.`,
        `Notices meant only for the organisers come here instead of by DM.`,
        ``,
        `Nothing I say here goes to the players. Type *help* here any time to see what I take.`,
      ].join("\n"),
    );
  });

  it("MatchTime announces but a teams time is set: YES posts the teams in the main chat", () => {
    const text = buildAdminGroupIntro({ ...DEFAULT_CLUB, teamsReadyTime: "09:30" });
    expect(text).toContain(`build balanced teams here at 09:30 on match day for you to check`);
    expect(text).toContain(`I post the squad list in the main chat, and the teams there once you say *YES* here.`);
  });

  it("an explicit 'off' teams time says nothing about teams, even when the organisers announce", () => {
    const text = buildAdminGroupIntro({ ...FNF, teamsReadyTime: "off" });
    expect(text).not.toMatch(/balanced teams/);
    expect(text).toContain(`I keep track of who's *IN* and *OUT* in the main chat, make the poster and team sheet, and run`);
  });

  it("games on more than one day, or none: 'games', not a day", () => {
    expect(buildAdminGroupIntro({ ...FNF, activityDays: [2, 5] })).toMatch(/^👋 I'm MatchTime, I'll help run \*FNF\*'s games\./);
    expect(buildAdminGroupIntro({ ...FNF, activityDays: [] })).toMatch(/^👋 I'm MatchTime, I'll help run \*FNF\*'s games\./);
    expect(buildAdminGroupIntro({ ...FNF, activityDays: [5, 5] })).toMatch(/'s Fridays\./);
  });

  it("only what is switched on: no MoM, no ratings, no attendance", () => {
    const text = buildAdminGroupIntro({ ...FNF, featureMomVoting: false, featurePlayerRating: false, featureAttendance: false });
    expect(text).not.toMatch(/Man of the Match|ratings|IN\*|squad list|rating notice|badges/);
    expect(text).toContain(`I build balanced teams here at 10:00 on match day for you to check and make the poster and team sheet.`);
    expect(text).toContain(`Notices meant only for the organisers come here instead of by DM.`);
  });

  it("MoM alone, ratings alone; the rating notice is relayed only with ratings on", () => {
    expect(buildAdminGroupIntro({ ...FNF, featurePlayerRating: false })).toContain(`run Man of the Match after the game.`);
    expect(buildAdminGroupIntro({ ...FNF, featureMomVoting: false })).toContain(`run player ratings after the game.`);
    expect(buildAdminGroupIntro({ ...FNF, featurePlayerRating: false })).toContain(`Notices meant only for the organisers come here instead of by DM.`);
  });

  it("badges are never claimed for HQ: they post in the players' group for every club (Kemal, 2026-10-16)", () => {
    for (const club of [FNF, DEFAULT_CLUB, { ...FNF, featurePlayerRating: false }]) {
      for (const language of ["en", "tr"]) {
        expect(buildAdminGroupIntro({ ...club, language })).not.toMatch(/badge|rozet/i);
      }
    }
  });

  it("a monthly club: no weekly list, no teams time, the collector's PAID", () => {
    const text = buildAdminGroupIntro({ ...DEFAULT_CLUB, squadMode: "monthly", teamsReadyTime: "10:00", benchPickMode: "organiser" });
    expect(text).not.toMatch(/IN\*|squad list|balanced teams/);
    expect(text).toContain(`Money collector: answer my list of payment claims here with *PAID ALL*, *PAID 1 3* or *PAID NONE*.`);
    expect(text).toContain(`When a place opens and someone is waiting, I ask here who plays.`);
  });

  it("a club not switched on yet (setting up): says so, and help only once it is on", () => {
    const text = buildAdminGroupIntro({ ...FNF, whatsappBotEnabled: false });
    expect(text.split("\n")[0]).toBe(`👋 I'm MatchTime, I'll help run *FNF*'s Fridays. Once I'm switched on for the club, this is what I do.`);
    expect(text.split("\n").at(-1)).toBe(`Nothing I say here goes to the players. Once I'm on, type *help* here to see what I take.`);
    expect(text).not.toMatch(/any time/);
  });

  it("a row with the feature columns missing reads them at their database defaults (on)", () => {
    const { featureAttendance, featureMomVoting, featurePlayerRating, ...bare } = FNF;
    void featureAttendance; void featureMomVoting; void featurePlayerRating;
    expect(buildAdminGroupIntro(bare)).toBe(buildAdminGroupIntro(FNF));
  });

  it("about six to eight lines, no long dashes, no time-of-day greeting", () => {
    for (const club of [FNF, DEFAULT_CLUB, { ...FNF, language: "tr" }, { ...DEFAULT_CLUB, squadMode: "monthly", language: "tr" }]) {
      const text = buildAdminGroupIntro(club);
      expect(text.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(8);
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
    }
  });
});

describe("buildAdminGroupIntro, Turkish", () => {
  it("FNF in Turkish", () => {
    expect(buildAdminGroupIntro({ ...FNF, language: "tr" })).toBe(
      [
        `👋 Ben MatchTime. *FNF* cuma maçlarını yönetmenize yardım edeceğim.`,
        `Ana grupta kimin *varım*, kimin *yokum* dediğini takip ederim, maç günü saat 10:00 itibarıyla kontrol etmeniz için burada dengeli takımlar kurarım, liste posterini ve takım listesini hazırlarım ve maçtan sonra maçın adamı oylamasını ve puanlamayı yürütürüm.`,
        `Kadro listesi ve takımlar, oyunculara sizin paylaşmanız için burada kalır.`,
        `Bir yer açılınca ve bekleyen biri varsa, kimin oynayacağını burada sorarım.`,
        `Sadece organizatörlere yönelik bildirimler özel mesaj yerine buraya gelir; oyunculara iletmeniz için puanlama duyurusu da buraya gelir.`,
        ``,
        `Burada yazdıklarım oyunculara gitmez. Neleri kabul ettiğimi görmek için burada istediğiniz zaman *yardım* yazın.`,
      ].join("\n"),
    );
  });

  it("a default club in Turkish", () => {
    expect(buildAdminGroupIntro({ ...DEFAULT_CLUB, language: "tr" })).toBe(
      [
        `👋 Ben MatchTime. *Harbour FC* salı maçlarını yönetmenize yardım edeceğim.`,
        `Ana grupta kimin *varım*, kimin *yokum* dediğini takip ederim, liste posterini ve takım listesini hazırlarım ve maçtan sonra maçın adamı oylamasını ve puanlamayı yürütürüm.`,
        `Kadro listesini ana grupta ben paylaşırım.`,
        `Sadece organizatörlere yönelik bildirimler özel mesaj yerine buraya gelir.`,
        ``,
        `Burada yazdıklarım oyunculara gitmez. Neleri kabul ettiğimi görmek için burada istediğiniz zaman *yardım* yazın.`,
      ].join("\n"),
    );
  });

  it("monthly, setting up, teams posted, in Turkish", () => {
    const monthly = buildAdminGroupIntro({ ...DEFAULT_CLUB, language: "tr", squadMode: "monthly" });
    expect(monthly).toContain(`*ÖDENDİ HEPSİ*, *ÖDENDİ 1 3* ya da *ÖDENDİ YOK*`);
    const off = buildAdminGroupIntro({ ...FNF, language: "tr", whatsappBotEnabled: false });
    expect(off.split("\n")[0]).toBe(`👋 Ben MatchTime. *FNF* cuma maçlarını yönetmenize yardım edeceğim. Kulüp için açıldığımda burada şunları yaparım.`);
    expect(off.split("\n").at(-1)).toBe(`Burada yazdıklarım oyunculara gitmez. Açıldığımda, neleri kabul ettiğimi görmek için burada *yardım* yazın.`);
    const posted = buildAdminGroupIntro({ ...DEFAULT_CLUB, language: "tr", teamsReadyTime: "09:30" });
    expect(posted).toContain(`Kadro listesini ana grupta ben paylaşırım; burada *EVET* yazdığınızda takımları da orada paylaşırım.`);
    expect(posted).toContain(`maç günü saat 09:30 itibarıyla`);
  });
});

describe("the intro and the help read the same gates", () => {
  it("hqHelpGates is what the HQ help is built from", () => {
    expect(hqHelpGates(FNF)).toEqual({ squad: true, graphics: true, picks: true, paid: false, free: false });
    expect(hqHelpGates(DEFAULT_CLUB)).toEqual({ squad: true, graphics: true, picks: false, paid: false, free: false });
    expect(hqHelpGates({ squadMode: "monthly", benchPickMode: "organiser" })).toEqual({ squad: false, graphics: true, picks: true, paid: true, free: false });
  });

  it("the intro names the pick and PAID exactly when the help lists them", () => {
    for (const club of [
      FNF,
      DEFAULT_CLUB,
      { ...FNF, squadMode: "monthly" },
      { ...DEFAULT_CLUB, squadMode: "monthly" },
      { ...DEFAULT_CLUB, benchPickMode: "organiser" },
    ]) {
      const gates = hqHelpGates(club);
      const intro = buildAdminGroupIntro(club);
      const help = buildHqHelp({ lang: "en", ...gates });
      expect(intro.includes("I ask here who plays")).toBe(help.includes("pick who plays"));
      expect(intro.includes("*PAID ALL*")).toBe(help.includes("*PAID ALL*"));
      expect(intro.includes("poster")).toBe(help.includes("poster"));
    }
  });
});
