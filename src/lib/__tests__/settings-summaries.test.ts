/**
 * The one-line summary each collapsed card on /admin/settings shows
 * (2026-10-28), in English and Turkish, from data the page already has.
 */
import { describe, expect, it } from "vitest";
import * as S from "../settings-summaries";

describe("settings card summaries", () => {
  it("club details: the name and the member count", () => {
    expect(S.clubDetailsSummary("en", { name: "E2E FC", memberCount: 12 })).toBe("E2E FC, 12 members");
    expect(S.clubDetailsSummary("en", { name: "E2E FC", memberCount: 1 })).toBe("E2E FC, 1 member");
    expect(S.clubDetailsSummary("tr", { name: "E2E FC", memberCount: 12 })).toBe("E2E FC, 12 üye");
  });

  it("bot language: the language's own name", () => {
    expect(S.languageSummary("en")).toBe("English");
    expect(S.languageSummary("tr")).toBe("Türkçe");
  });

  it("WhatsApp bot: on, off, or waiting to go live", () => {
    expect(S.whatsappSummary("en", { enabled: true })).toBe("On in your players' group");
    expect(S.whatsappSummary("en", { enabled: false })).toBe("Off");
    expect(S.whatsappSummary("tr", { enabled: true })).toBe("Oyuncu grubunuzda açık");
    expect(S.whatsappSummary("tr", { enabled: false })).toBe("Kapalı");
    expect(S.whatsappSummary("en", { enabled: false, settingUp: true })).toBe("Waiting for you to go live");
  });

  it("weekly routine: the rolling squad (weekly clubs only) and the deadlines set", () => {
    expect(S.weeklyRoutineSummary("en", { rollingSquad: false, deadlines: 0 })).toBe("Rolling squad: off, no weekly deadlines");
    expect(S.weeklyRoutineSummary("en", { rollingSquad: true, deadlines: 2 })).toBe("Rolling squad: on, 2 weekly deadlines set");
    expect(S.weeklyRoutineSummary("en", { rollingSquad: null, deadlines: 1 })).toBe("1 weekly deadline set");
    expect(S.weeklyRoutineSummary("tr", { rollingSquad: true, deadlines: 0 })).toBe("Kadro devam eder: açık, haftalık son saat yok");
  });

  it("reminders: personal reminders and the kit reminder", () => {
    expect(S.remindersSummary("en", { personal: true, gear: false })).toBe("Personal reminders: on, Match-day kit reminder: off");
    expect(S.remindersSummary("tr", { personal: false, gear: true })).toBe("Hatırlatmalar: kapalı, Maç günü malzeme hatırlatması: açık");
  });

  it("teams: team generation and the two names", () => {
    expect(S.teamsSummary("en", { balancing: true, first: "Red", second: "Yellow" })).toBe("Team generation: on, Red and Yellow");
    expect(S.teamsSummary("tr", { balancing: false, first: "Kırmızı", second: "Sarı" })).toBe("Takım kurma: kapalı, Kırmızı ve Sarı");
  });

  it("monthly squad: weekly or monthly", () => {
    expect(S.monthlySquadSummary("en", "weekly")).toBe("Weekly squad");
    expect(S.monthlySquadSummary("en", "monthly")).toBe("Monthly squad");
    expect(S.monthlySquadSummary("tr", "monthly")).toBe("Aylık kadro");
  });

  it("attendance and automatic asking: on or off", () => {
    expect(S.onOffSummary("en", true)).toBe("On");
    expect(S.onOffSummary("en", false)).toBe("Off");
    expect(S.onOffSummary("tr", true)).toBe("Açık");
  });

  it("bench: off, or on and who fills an open place", () => {
    expect(S.benchSummary("en", { on: true, pickMode: "first-come" })).toBe("On, first come, first served");
    expect(S.benchSummary("en", { on: true, pickMode: "organiser" })).toBe("On, organisers pick");
    expect(S.benchSummary("en", { on: false, pickMode: "organiser" })).toBe("Off");
    expect(S.benchSummary("tr", { on: true, pickMode: "organiser" })).toBe("Açık, organizatörler seçer");
  });

  it("ratings and stats: the three switches", () => {
    expect(S.ratingsSummary("en", { ratings: true, badges: true, stats: false })).toBe(
      "Player ratings: on, Badge announcements: on, Stats answers: off",
    );
    expect(S.ratingsSummary("tr", { ratings: false, badges: true, stats: true })).toBe(
      "Oyuncu puanları: kapalı, Rozet duyuruları: açık, İstatistik cevapları: açık",
    );
  });

  it("Man of the Match: off, or on and who chooses", () => {
    expect(S.momSummary("en", { on: true, chosenBy: "players" })).toBe("On, players vote");
    expect(S.momSummary("en", { on: true, chosenBy: "organisers" })).toBe("On, organisers choose");
    expect(S.momSummary("en", { on: false, chosenBy: "players" })).toBe("Off");
    expect(S.momSummary("tr", { on: true, chosenBy: "players" })).toBe("Açık, oyuncular oy verir");
  });

  it("payments: collecting or not, and the bank", () => {
    expect(S.paymentsSummary("en", { collecting: false, bankConnected: false })).toBe("Not collecting match fees");
    expect(S.paymentsSummary("en", { collecting: true, bankConnected: true })).toBe("Collecting match fees, bank connected");
    expect(S.paymentsSummary("en", { collecting: true, bankConnected: false })).toBe("Collecting match fees, bank not connected yet");
    expect(S.paymentsSummary("tr", { collecting: true, bankConnected: true })).toBe("Maç ücreti toplanıyor, banka bağlı");
  });

  it("billing: this month's line, else the first line", () => {
    expect(S.billingSummary({ lines: ["Trial until 1 Dec"], month: "This month so far: £4" })).toBe("This month so far: £4");
    expect(S.billingSummary({ lines: ["Trial until 1 Dec"], month: null })).toBe("Trial until 1 Dec");
    expect(S.billingSummary({ lines: [] })).toBe("");
  });

  it("partner clubs: how many, and requests waiting", () => {
    expect(S.partnerClubsSummary("en", { partners: 0, requestsWaiting: 0 })).toBe("No partner clubs yet");
    expect(S.partnerClubsSummary("en", { partners: 1, requestsWaiting: 0 })).toBe("1 partner club");
    expect(S.partnerClubsSummary("en", { partners: 2, requestsWaiting: 1 })).toBe("2 partner clubs, 1 request waiting");
    expect(S.partnerClubsSummary("en", { partners: 0, requestsWaiting: 2 })).toBe("No partner clubs yet, 2 requests waiting");
    expect(S.partnerClubsSummary("tr", { partners: 2, requestsWaiting: 1 })).toBe("2 partner kulüp, bekleyen istek: 1");
  });

  it("player pool: on or off, and automatic asking once known", () => {
    expect(S.playerPoolSummary("en", { on: true, autoAsk: false })).toBe("On, automatic asking off");
    expect(S.playerPoolSummary("en", { on: true, autoAsk: true })).toBe("On, automatic asking on");
    expect(S.playerPoolSummary("en", { on: true, autoAsk: null })).toBe("On");
    expect(S.playerPoolSummary("en", { on: false, autoAsk: true })).toBe("Off");
    expect(S.playerPoolSummary("tr", { on: true, autoAsk: false })).toBe("Açık, otomatik sorma kapalı");
  });

  it("style of play: the style, or not set", () => {
    expect(S.playStyleSummary("en", "Casual")).toBe("Casual");
    expect(S.playStyleSummary("en", null)).toBe("Not set");
    expect(S.playStyleSummary("tr", null)).toBe("Seçilmedi");
  });

  it("tell your players: the card's own state line", () => {
    expect(S.clubShareSummary("en", { kind: "ready", statusLine: null })).toBe("Not sent yet");
    expect(S.clubShareSummary("en", { kind: "no-group", statusLine: null })).toBe("Connect your players' group first");
    expect(S.clubShareSummary("en", { kind: "queued", statusLine: "Queued: goes out at 09:00." })).toBe("Queued: goes out at 09:00.");
    expect(S.clubShareSummary("tr", { kind: "ready", statusLine: null })).toBe("Henüz gönderilmedi");
  });

  it("group invite link: who makes it, or none yet", () => {
    expect(S.groupInviteLinkSummary("en", "bot")).toBe("MatchTime makes the link");
    expect(S.groupInviteLinkSummary("en", "pasted")).toBe("Link saved");
    expect(S.groupInviteLinkSummary("en", "none")).toBe("No link yet");
    expect(S.groupInviteLinkSummary("tr", "none")).toBe("Henüz bağlantı yok");
  });

  it("quiet hours: off, or on with the hours", () => {
    expect(S.quietHoursSummary("en", { enabled: true, from: "23:00", to: "09:00" })).toBe("On, 23:00 to 09:00");
    expect(S.quietHoursSummary("en", { enabled: false, from: "23:00", to: "09:00" })).toBe("Off");
    expect(S.quietHoursSummary("tr", { enabled: true, from: "23:00", to: "09:00" })).toBe("Açık, 23:00 ile 09:00 arası");
  });

  it("admin messages: where they go", () => {
    expect(S.adminGroupSummary("en", { mode: "one-person", group: null })).toBe("By private message to one person");
    expect(S.adminGroupSummary("en", { mode: "admin-group", group: "FC Admins" })).toBe("Admin group: FC Admins");
    expect(S.adminGroupSummary("en", { mode: "admin-group", group: null })).toBe("Admin group, not linked yet");
    expect(S.adminGroupSummary("en", { mode: "each-admin", group: null })).toBe("By private message to each admin");
    expect(S.adminGroupSummary("tr", { mode: "admin-group", group: "FC Yönetim" })).toBe("Yönetici grubu: FC Yönetim");
  });

  it("posters: the design in use, by its gallery name", () => {
    const options = [
      { id: "matchtime", name: "MatchTime design" },
      { id: "own", name: "Your own background" },
    ];
    expect(S.postersSummary(options, "own")).toBe("Your own background");
    expect(S.postersSummary(options, "gone")).toBeNull();
  });

  it("every summary is one line, with no dash, no slash between words and never 'free'", () => {
    const all = [
      S.clubDetailsSummary("en", { name: "X", memberCount: 3 }),
      S.weeklyRoutineSummary("en", { rollingSquad: true, deadlines: 2 }),
      S.weeklyRoutineSummary("tr", { rollingSquad: true, deadlines: 2 }),
      S.benchSummary("en", { on: true, pickMode: "first-come" }),
      S.benchSummary("tr", { on: true, pickMode: "first-come" }),
      S.paymentsSummary("tr", { collecting: true, bankConnected: false }),
      S.partnerClubsSummary("tr", { partners: 0, requestsWaiting: 0 }),
      S.adminGroupSummary("tr", { mode: "each-admin", group: null }),
      S.adminGroupSummary("tr", { mode: "one-person", group: null }),
      S.groupInviteLinkSummary("tr", "bot"),
      S.inviteLinkSummary("en"),
      S.inviteLinkSummary("tr"),
    ];
    for (const line of all) {
      expect(line).not.toMatch(/\n/);
      expect(line).not.toMatch(/[—–]/);
      expect(line).not.toMatch(/\w\/\w/);
      expect(line).not.toMatch(/\bfree\b/i);
    }
  });
});
