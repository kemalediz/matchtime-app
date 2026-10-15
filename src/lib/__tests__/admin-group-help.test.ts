/**
 * "help" IN A CLUB'S ADMIN GROUP (2026-10-15): the pure half.
 *
 * Every command the HQ help quotes is fed here to the parser that reads it
 * in the admin group, so the help can never list a command the code does
 * not take:
 *
 *   paste + YES           admin-group-squad-rules.ts readSquadPaste, isAdminGroupYes
 *   teams / reshuffle / swap / move
 *                         team-proposal-rules.ts parseTeamCommand
 *   poster / team sheet   admin-group-graphics.ts parseGraphicsCommand
 *   PAID ALL / 1 3 / NONE month-payment-rules.ts readCollectorReply
 *   ALL / NONE (picks)    organiser-pick-rules.ts parsePickReply
 *
 * The one-change line ("put Bilal in") is read by the router, a model call,
 * so it is not run here; its wording is the module's own header
 * (admin-group-squad-change.ts) and e2e/api/admin-group-squad.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { buildHqHelp, isHqHelpRequest } from "@/lib/admin-group-help";
import { parseTeamCommand } from "@/lib/team-proposal-rules";
import { parseGraphicsCommand } from "@/lib/admin-group-graphics";
import { readCollectorReply } from "@/lib/month-payment-rules";
import { isAdminGroupYes, readSquadPaste } from "@/lib/admin-group-squad-rules";
import { parsePickReply } from "@/lib/organiser-pick-rules";

describe("isHqHelpRequest", () => {
  it.each([
    "help",
    "Help",
    "HELP",
    "help?",
    "help!",
    " help ",
    "@Match Time help",
    "@MatchTime help",
    "Match Time, help",
    "matchtime help",
    "@447700900999 help",
    "@123456789012345 help",
    "yardım",
    "Yardım",
    "YARDIM",
    "yardim",
    "@Match Time yardım",
    "@447700900999 yardım?",
  ])("reads %j as help", (text) => {
    expect(isHqHelpRequest(text)).toBe(true);
  });

  it.each([
    "",
    "help me out here lads",
    "can someone help with the list",
    "help teams",
    "Tom out",
    "put Bilal in",
    "teams",
    "helpful",
    "yardımcı olur musun",
    "1. help\n2. Tom",
  ])("does not read %j as help", (text) => {
    expect(isHqHelpRequest(text)).toBe(false);
  });
});

const ALL = { squad: true, graphics: true, picks: true, paid: true };

describe("buildHqHelp, English", () => {
  it("a live weekly club whose organisers pick (FNF): the whole list", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: true, paid: false })).toBe(
      [
        `🛠️ *MatchTime in your admin group*`,
        `Send any of these here, each as a message of its own. No need to tag me.`,
        ``,
        `📋 *Paste the whole squad list*: I show you what would change, and *YES* within 30 minutes applies it.`,
        `✏️ *"put Bilal in"*, *"Sam out"*, *"Tom to the bench"*: one change to the squad.`,
        `🟥🟦 *teams*: show the teams, or build them if there are none yet.`,
        `🔀 *reshuffle*: build new teams.`,
        `🔁 *swap Sam and Alex*: swap two players between the teams.`,
        `➡️ *move Sam*: move one player to the other team.`,
        `✅ *YES*: make the proposed teams final.`,
        `🖼️ *poster*: the list as a graphic. *team sheet*: the teams as a graphic. Both ready to forward.`,
        `🙋 When I ask you to pick who plays, reply with the numbers or names from my list, or *ALL* or *NONE*.`,
        ``,
        `Type *help* here any time to see this again.`,
      ].join("\n"),
    );
  });

  it("a monthly club: no weekly squad commands, the collector's PAID line instead", () => {
    const out = buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true });
    expect(out).toContain(`💷 *PAID ALL*, *PAID 1 3* or *PAID NONE*: the money collector's answer to my list of payment claims.`);
    expect(out).not.toContain("Paste the whole squad list");
    expect(out).not.toContain("*reshuffle*");
    expect(out).not.toContain("pick who plays");
    expect(out).toContain("*poster*");
  });

  it("first-come club: no pick line", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("pick who plays");
  });
});

describe("buildHqHelp, Turkish", () => {
  it("the whole list", () => {
    expect(buildHqHelp({ lang: "tr", ...ALL })).toBe(
      [
        `🛠️ *Yönetici grubunda MatchTime*`,
        `Bunları burada, her birini ayrı bir mesaj olarak yazın. Beni etiketlemenize gerek yok.`,
        ``,
        `📋 *Kadro listesinin tamamını yapıştırın*: neyin değişeceğini gösteririm, 30 dakika içinde *EVET* yazarsanız uygularım.`,
        `✏️ *"Bilal var"*, *"Sam yok"*, *"Tom yedek"*: kadroda tek bir değişiklik.`,
        `🟥🟦 *takımlar*: takımları gösteririm, henüz yoksa kurarım.`,
        `🔀 *yeniden*: yeni takımlar kurarım.`,
        `🔁 *Sam ile Alex değiş*: iki oyuncunun takımlarını değiştiririm.`,
        `➡️ *Sam'i taşı*: bir oyuncuyu diğer takıma geçiririm.`,
        `✅ *EVET*: önerilen takımları kesinleştiririm.`,
        `🖼️ *liste posteri*: listeyi görsel olarak. *takım listesi*: takımları görsel olarak. İkisi de iletmeye hazır gelir.`,
        `🙋 Kimin oynayacağını seçmenizi istediğimde listemdeki numaraları ya da isimleri, veya *HEPSİ* ya da *HİÇBİRİ* yazın.`,
        `💷 *ÖDENDİ HEPSİ*, *ÖDENDİ 1 3* ya da *ÖDENDİ YOK*: parayı toplayan kişinin ödeme bildirimleri listeme cevabı.`,
        ``,
        `Bunu tekrar görmek için burada istediğiniz zaman *yardım* yazın.`,
      ].join("\n"),
    );
  });
});

describe("house rules", () => {
  it("no em or en dashes, no greeting, no phone number", () => {
    for (const lang of ["en", "tr"]) {
      const out = buildHqHelp({ lang, ...ALL });
      expect(out).not.toMatch(/[—–]/);
      expect(out).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
      expect(out).not.toMatch(/\+?\d{10,}/);
    }
  });
});

describe("every command the help quotes is one the admin group really takes", () => {
  it("team commands (team-proposal-rules.ts parseTeamCommand)", () => {
    expect(parseTeamCommand("teams")).toEqual({ kind: "show" });
    expect(parseTeamCommand("reshuffle")).toEqual({ kind: "reshuffle" });
    expect(parseTeamCommand("swap Sam and Alex")).toMatchObject({ kind: "swap", pairs: [["Sam", "Alex"]] });
    expect(parseTeamCommand("move Sam")).toEqual({ kind: "move", name: "Sam" });
    expect(parseTeamCommand("takımlar")).toEqual({ kind: "show" });
    expect(parseTeamCommand("yeniden")).toEqual({ kind: "reshuffle" });
    expect(parseTeamCommand("Sam ile Alex değiş")).toMatchObject({ kind: "swap", pairs: [["Sam", "Alex"]] });
    expect(parseTeamCommand("Sam'i taşı")).toEqual({ kind: "move", name: "Sam" });
  });

  it("YES / EVET (admin-group-squad-rules.ts isAdminGroupYes)", () => {
    expect(isAdminGroupYes("YES")).toBe(true);
    expect(isAdminGroupYes("EVET")).toBe(true);
  });

  it("graphics (admin-group-graphics.ts parseGraphicsCommand)", () => {
    expect(parseGraphicsCommand("poster")).toBe("list");
    expect(parseGraphicsCommand("team sheet")).toBe("teams");
    expect(parseGraphicsCommand("liste posteri")).toBe("list");
    expect(parseGraphicsCommand("takım listesi")).toBe("teams");
  });

  it("PAID (month-payment-rules.ts readCollectorReply)", () => {
    expect(readCollectorReply("PAID ALL")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("PAID 1 3")).not.toBeNull();
    expect(readCollectorReply("PAID NONE")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ HEPSİ")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("ÖDENDİ 1 3")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ YOK")).not.toBeNull();
  });

  it("ALL / NONE to a pick (organiser-pick-rules.ts parsePickReply)", () => {
    const ctx = { list: [], confirmed: [], members: [], pendingConfirm: false, tags: [] };
    expect(parsePickReply("ALL", ctx, "group")).toEqual({ kind: "all" });
    expect(parsePickReply("NONE", ctx, "group")).toEqual({ kind: "none" });
    expect(parsePickReply("HEPSİ", ctx, "group")).toEqual({ kind: "all" });
    expect(parsePickReply("HİÇBİRİ", ctx, "group")).toEqual({ kind: "none" });
  });

  it("a pasted list is read as the squad (admin-group-squad-rules.ts readSquadPaste)", () => {
    expect(readSquadPaste("1. Sam\n2. Alex\n3. Tom\n4. Ben", 6)).not.toBeNull();
  });

  it("help itself is none of those, so nothing else could answer it first", () => {
    for (const text of ["help", "@Match Time help", "yardım"]) {
      expect(parseTeamCommand(text)).toBeNull();
      expect(parseGraphicsCommand(text)).toBeNull();
      expect(readCollectorReply(text)).toBeNull();
      expect(isAdminGroupYes(text)).toBe(false);
      expect(readSquadPaste(text, 18)).toBeNull();
    }
  });
});
