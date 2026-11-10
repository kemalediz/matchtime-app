/**
 * "WHAT CAN YOU DO?" IN A CLUB'S ADMIN GROUP (2026-10-15; asked in any
 * words since 2026-10-16): the answer.
 *
 * Since 2026-11-10 (Kemal: "why this long menu") the answer is a short
 * menu (`buildHqHelp`) and each topic's full lines come on "help <topic>"
 * (`buildHqTopicLines`); help-short-menus.test.ts pins that nothing of the
 * old long menu was lost. Here: the lines themselves.
 *
 * Asking for it, and every request its examples show, is read by the
 * shared router (live check in the PR). The STRUCTURED lines (PAID, a pick
 * from the numbered list, a pasted list) are still read deterministically,
 * so those are fed here to the reader that takes them.
 */
import { describe, expect, it } from "vitest";
import { buildHqHelp, buildHqTopicLines, hqHelpGates, HQ_HELP_TOPICS, type HqHelpGates } from "@/lib/admin-group-help";
import { t } from "@/lib/i18n/t";
import { readCollectorReply } from "@/lib/__tests__/fixtures/monthly-legacy";
import { HQ_SQUAD_READER_SYSTEM } from "@/lib/hq-squad-reader-prompt";
import { PICK_READER_SYSTEM } from "@/lib/organiser-pick-reader-prompt";

const ALL = { squad: true, graphics: true, picks: true, paid: true };

/** Every topic's lines for a club, as "help <topic>" shows them, one after another. */
const topics = (p: HqHelpGates & { lang: string }) => HQ_HELP_TOPICS.map((tp) => buildHqTopicLines(tp, p)).filter(Boolean).join("\n");

describe("the HQ topics, English", () => {
  it("a live weekly club whose organisers pick (FNF): each topic in full", () => {
    const g = { lang: "en", squad: true, graphics: true, picks: true, paid: false };
    const tag = `tag me in every message here (type *@*, pick *Match Time*), for example:`;
    expect(buildHqTopicLines("squad", g)).toBe(
      [
        `📋 *Squad*: ${tag}`,
        `📋 *Tag me and paste the whole squad list*: I show you what would change, and *@Match Time YES* within 30 minutes applies it.`,
        `✏️ *"@Match Time put Bilal in"*, *"@Match Time Sam can't make it"*, *"@Match Time Tom to the bench"*, *"@Match Time swap Tom for Ben"*: changes to the squad (a swap brings Ben up from the bench and puts Tom on it).`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("teams", g)).toBe(
      [
        `🟥🟦 *Teams*: ${tag}`,
        `🟥🟦 *"@Match Time show me the teams"*: the teams as they stand. *"@Match Time make the teams"*, *"@Match Time shuffle them again"*: new teams.`,
        `↩️ Reply to one of my earlier team sheets with *"@Match Time use these"*, or tag me and paste the two teams: I bring those teams back for your *@Match Time YES*.`,
        `🔁 *"@Match Time swap Sam and Alex"*, *"@Match Time move Sam to the other team"*: changes to the teams. On match day after kickoff, these and *"@Match Time put Ben in for Sam"* fix the game just played, and nothing is posted in the players' group.`,
        `✅ *@Match Time YES*: make the proposed teams final.`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("players", g)).toBe(
      [
        `📣 *Finding players*: ${tag}`,
        `📣 *"@Match Time ask the group if anyone can play"*: when a place is open, I ask in the main chat.`,
        `📨 Reply to a message that tags people with *"@Match Time DM them"*, or say *"@Match Time DM the people above"*: I DM each of them the invite for the next game. Only numbers I already know, up to 10 at a time.`,
        `🙋 When I ask you to pick who plays, tag me with the numbers or names from my list, or *ALL* or *NONE* (for example *@Match Time 2 3*).`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("game", g)).toBe(
      [
        `🗓️ *The game*: ${tag}`,
        `❌ *"@Match Time cancel Friday"*, *"@Match Time it's back on"*: call the next match off or back on, and I tell the players' group.`,
        `🔁 *"@Match Time make it 8 a side"*, *"@Match Time 6 a side on Monday"*: one game a different size, inside those numbers. Going up, the bench moves in; going down, the last to join go to the bench. Each is told by DM, and I post the new list.`,
        `🕗 *"@Match Time move Monday's game to 20:15"*, *"@Match Time from now on we kick off at 20:15"*: one game to another time or day of its week, or your weekly game from now on, with its games still to be played. Quietly: I don't post it in the players' group.`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("settings", g)).toBe(
      [
        `⚙️ *Settings*: ${tag}`,
        `🌙 *"@Match Time turn on quiet hours from 23:00 to 09:00"*, *"@Match Time turn off quiet hours"*: I hold my own messages overnight, or send at any time. A new club starts with quiet hours off.`,
        `👥 *"@Match Time we play with 12 to 16"*, *"@Match Time we can play with 12"*: the fewest and most you play with. I only warn you about low numbers, or offer to cancel, below the fewest, and when two are waiting on the bench I suggest going up a size (with one waiting, the list says one more would do it). *"@Match Time back to full teams"* undoes the fewest.`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("graphics", g)).toBe(
      [`🖼️ *Graphics*: ${tag}`, `🖼️ *"@Match Time send the poster"*, *"@Match Time team sheet please"*: the list or the teams as a graphic, ready to forward.`].join("\n"),
    );
    expect(buildHqTopicLines("payments", g)).toBe("");
  });

  it("a monthly club: no weekly squad commands, the collector's PAID line instead", () => {
    const g = { lang: "en", squad: false, graphics: true, picks: false, paid: true };
    expect(buildHqTopicLines("payments", g)).toContain(`💷 *@Match Time PAID ALL*, *@Match Time PAID 1 3* or *@Match Time PAID NONE*: the money collector's answer to my list of payment claims.`);
    const out = topics(g);
    expect(out).not.toContain("paste the whole squad list");
    expect(out).not.toContain("shuffle them again");
    expect(out).not.toContain("pick who plays");
    expect(out).toContain("send the poster");
    for (const tp of ["squad", "teams", "players"] as const) expect(buildHqTopicLines(tp, g)).toBe("");
  });

  it("first-come club: no pick line", () => {
    expect(topics({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("pick who plays");
  });
});

describe("the HQ topics, Turkish", () => {
  it("each topic in full", () => {
    const g = { lang: "tr", ...ALL };
    const tag = `burada her mesajda beni etiketleyin (*@* yazıp *Match Time*'ı seçin), örneğin:`;
    expect(buildHqTopicLines("squad", g)).toBe(
      [
        `📋 *Kadro*: ${tag}`,
        `📋 *Beni etiketleyip kadro listesinin tamamını yapıştırın*: neyin değişeceğini gösteririm, 30 dakika içinde *@Match Time EVET* yazarsanız uygularım.`,
        `✏️ *"@Match Time Bilal'i ekle"*, *"@Match Time Sam gelemiyor"*, *"@Match Time Tom yedek"*, *"@Match Time Tom yedeğe, Ben kadroya"*: kadroda değişiklik.`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("players", g)).toBe(
      [
        `📣 *Oyuncu bulmak*: ${tag}`,
        `📣 *"@Match Time gruba sor, oynayabilecek var mı"*: boş yer varsa ana grupta sorarım.`,
        `📨 Kişileri etiketleyen bir mesaja *"@Match Time onlara özelden yaz"* diye yanıt verin ya da *"@Match Time yukarıdakilere özelden yaz"* deyin: her birine sıradaki maçın davetini özelden gönderirim. Yalnızca tanıdığım numaralara, bir seferde en fazla 10 kişiye.`,
        `🙋 Kimin oynayacağını seçmenizi istediğimde beni etiketleyip listemdeki numaraları ya da isimleri, veya *HEPSİ* ya da *HİÇBİRİ* yazın (örneğin *@Match Time 2 3*).`,
      ].join("\n"),
    );
    expect(buildHqTopicLines("payments", g)).toBe(
      [`💷 *Ödemeler*: ${tag}`, `💷 *@Match Time ÖDENDİ HEPSİ*, *@Match Time ÖDENDİ 1 3* ya da *@Match Time ÖDENDİ YOK*: parayı toplayan kişinin ödeme bildirimleri listeme cevabı.`].join("\n"),
    );
    expect(buildHqTopicLines("game", g)).toContain(`🕗 *"@Match Time pazartesi maçını 20:15'e al"*, *"@Match Time artık 20:15'te başlıyoruz"*`);
    expect(buildHqTopicLines("settings", g)).toContain(`🌙 *"@Match Time sessiz saatleri 23:00 ile 09:00 arası aç"*`);
    expect(buildHqTopicLines("graphics", g)).toContain(`🖼️ *"@Match Time posteri gönder"*, *"@Match Time takım listesi görseli"*`);
  });
});

describe("a swap with the bench (2026-11-10, PR #581)", () => {
  it("the squad line shows the swap, EN and TR; only for a weekly squad; no dash, no waiting list", () => {
    const en = topics({ lang: "en", squad: true, graphics: true, picks: false, paid: false });
    expect(en).toContain(`*"@Match Time swap Tom for Ben"*: changes to the squad (a swap brings Ben up from the bench and puts Tom on it).`);
    const tr = topics({ lang: "tr", squad: true, graphics: true, picks: false, paid: false });
    expect(tr).toContain(`*"@Match Time Tom yedeğe, Ben kadroya"*: kadroda değişiklik.`);
    for (const out of [en, tr, buildHqHelp({ lang: "en", ...ALL }), buildHqHelp({ lang: "tr", ...ALL })]) {
      expect(out).not.toMatch(/[—–]/);
      expect(out).not.toMatch(/waiting list|bekleme listesi/i);
    }
    expect(buildHqHelp({ lang: "en", ...ALL })).toContain(`"swap Tom for Ben"`);
    expect(topics({ lang: "en", squad: false, graphics: true, picks: false, paid: true })).not.toContain("swap Tom for Ben");
    expect(buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true })).not.toContain("swap Tom for Ben");
  });
});

describe("the player pool line (2026-10-28, decision log H.1)", () => {
  it("listed only when the pool is open for a weekly club; EN and TR, no dash", () => {
    const en = topics({ lang: "en", squad: true, graphics: true, picks: false, paid: false, pool: true });
    expect(en).toContain(`🌍 *"@Match Time ask the player pool for 2 players"*: when a place is open, I ask nearby players from the MatchTime player pool.`);
    const tr = topics({ lang: "tr", squad: true, graphics: true, picks: false, paid: false, pool: true });
    expect(tr).toContain(`🌍 *"@Match Time havuzdan 2 oyuncu iste"*: boş yer varsa MatchTime oyuncu havuzundaki yakın oyunculara sorarım.`);
    for (const out of [en, tr]) expect(out).not.toMatch(/[—–]/);
    expect(topics({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("player pool");
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("player pool");
    // A monthly club has no weekly ask, so no line even when asked for.
    expect(topics({ lang: "en", squad: false, graphics: true, picks: false, paid: true, pool: true })).not.toContain("player pool");
  });
});

describe("free places (2026-10-16)", () => {
  it("a club that takes match fees gets the free-place line, EN and TR; one that does not, nothing", () => {
    const gates = (o: Parameters<typeof hqHelpGates>[0]) => hqHelpGates(o);
    expect(gates({ squadMode: "weekly", paymentCollectionEnabled: true }).free).toBe(true);
    expect(gates({ squadMode: "weekly", paymentTrackingEnabled: true }).free).toBe(true);
    expect(gates({ squadMode: "weekly" }).free).toBe(false);
    expect(buildHqTopicLines("payments", { lang: "en", ...ALL, free: true })).toContain(
      `🎁 *"@Match Time Bilal is free this week"*: a free place, so no pay link and no reminders to pay.`,
    );
    expect(buildHqTopicLines("payments", { lang: "tr", ...ALL, free: true })).toContain(
      `🎁 *"@Match Time Bilal bu hafta ücretsiz"*: ücretsiz yer, ödeme linki ve ödeme hatırlatması gitmez.`,
    );
    expect(topics({ lang: "en", ...ALL })).not.toContain("free place");
  });

  it("the collector's PAID line: a monthly club that tracks or collects payments only (2026-11-03)", () => {
    const gates = (o: Parameters<typeof hqHelpGates>[0]) => hqHelpGates(o);
    expect(gates({ squadMode: "monthly" }).paid).toBe(false);
    expect(gates({ squadMode: "monthly", paymentTrackingEnabled: true }).paid).toBe(true);
    expect(gates({ squadMode: "monthly", paymentCollectionEnabled: true }).paid).toBe(true);
    expect(gates({ squadMode: "weekly", paymentTrackingEnabled: true }).paid).toBe(false);
  });
});

describe("HQ needs the real tag (Kemal, 2026-10-31, #482)", () => {
  it("never says a tag is not needed, and says how to make the tag, EN and TR", () => {
    for (const squad of [true, false]) {
      const en = buildHqHelp({ lang: "en", ...ALL, squad, free: true, pool: true });
      const tr = buildHqHelp({ lang: "tr", ...ALL, squad, free: true, pool: true });
      const enTopics = topics({ lang: "en", ...ALL, squad, free: true, pool: true });
      const trTopics = topics({ lang: "tr", ...ALL, squad, free: true, pool: true });
      for (const out of [en, enTopics]) expect(out).not.toMatch(/no need to tag|reply YES to my message/i);
      for (const out of [tr, trTopics]) expect(out).not.toMatch(/etiketlemenize gerek yok|EVET diye cevap/i);
      expect(en).toContain("Tag me (type *@*, pick *Match Time*)");
      expect(tr).toContain("Beni etiketleyin (*@* yazıp *Match Time*'ı seçin)");
      expect(enTopics).toContain("tag me in every message here (type *@*, pick *Match Time*)");
      expect(trTopics).toContain("burada her mesajda beni etiketleyin (*@* yazıp *Match Time*'ı seçin)");
      for (const out of [en, tr, enTopics, trTopics]) {
        expect(out).not.toMatch(/[—–]/);
        expect(out).not.toMatch(/\w\/\w/);
      }
    }
  });

  it("the DM help that points an organiser to HQ shows the tagged ask, EN and TR", () => {
    expect(t("en").onbHelpAdminOrganisers).toContain("*@Match Time what can you do?*");
    expect(t("tr").onbHelpAdminOrganisers).toContain("*@Match Time neler yapabilirsin?*");
  });
});

describe("house rules", () => {
  it("no em or en dashes, no greeting, no phone number", () => {
    for (const lang of ["en", "tr"]) {
      for (const out of [buildHqHelp({ lang, ...ALL, free: true }), topics({ lang, ...ALL, free: true })]) {
        expect(out).not.toMatch(/[—–]/);
        expect(out).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
        expect(out).not.toMatch(/\+?\d{10,}/);
      }
    }
  });
});

describe("every STRUCTURED reply the help quotes is one the admin group really takes", () => {
  it("PAID (month-payment-rules.ts readCollectorReply)", () => {
    expect(readCollectorReply("PAID ALL")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("PAID 1 3")).not.toBeNull();
    expect(readCollectorReply("PAID NONE")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ HEPSİ")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("ÖDENDİ 1 3")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ YOK")).not.toBeNull();
  });

  it("ALL / NONE to a pick are read by the pick reader, a model (organiser-pick-reader-prompt.ts, 2026-10-30)", () => {
    expect(PICK_READER_SYSTEM).toContain(`"all" | "hepsi": all.`);
    expect(PICK_READER_SYSTEM).toContain(`"none", "nobody", "leave it" | "hiçbiri", "kimse": none.`);
  });

  it("a pasted list is read as the squad by the HQ squad reader, a model (hq-squad-reader-prompt.ts, 2026-10-29)", () => {
    expect(HQ_SQUAD_READER_SYSTEM).toContain(`"squad": the whole list of who plays the next game`);
  });

  it("asking what MatchTime can do is none of those structured replies", () => {
    for (const text of ["help", "what can you do?", "neler yapabilirsin?"]) {
      expect(readCollectorReply(text)).toBeNull();
    }
  });
});
