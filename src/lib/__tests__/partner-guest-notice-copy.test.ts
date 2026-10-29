/**
 * The players' group post about a PARTNER club's guest, for a club whose
 * only group is its players' group (Kemal, 2026-10-29: a partner guest is
 * an attendance change the whole club should see, as a pool guest is).
 * Worded for everyone, naming the partner club; never the organisers'
 * words ("answered your ask", "for you to pick") and never his standing at
 * his own club (another club's data).
 */
import { describe, expect, it } from "vitest";
import { partnerGuestGroupNotice, type PartnerGuestNoticeKind } from "../partner-guest-notice-copy";

const day = "Tue 27 Oct, 20:00";
const base = { name: "Ali K", partner: "Friday MT Community", day };

const all: { lang: "en" | "tr"; kind: PartnerGuestNoticeKind; organiserPicks: boolean; text: string }[] = [];
for (const lang of ["en", "tr"] as const)
  for (const kind of ["in", "bench", "out"] as const)
    for (const organiserPicks of [false, true]) all.push({ lang, kind, organiserPicks, text: partnerGuestGroupNotice(lang, { ...base, kind, organiserPicks }) });

describe("partnerGuestGroupNotice", () => {
  it("EN: joined, bench, bench in an organiser-pick club, dropped", () => {
    expect(partnerGuestGroupNotice("en", { ...base, kind: "in", organiserPicks: false })).toBe("🙋 Ali K from Friday MT Community has joined the squad for Tue 27 Oct, 20:00.");
    expect(partnerGuestGroupNotice("en", { ...base, kind: "bench", organiserPicks: false })).toBe("🙋 Ali K from Friday MT Community is on the bench for Tue 27 Oct, 20:00.");
    expect(partnerGuestGroupNotice("en", { ...base, kind: "bench", organiserPicks: true })).toBe(
      "🙋 Ali K from Friday MT Community is on the bench for Tue 27 Oct, 20:00. The organisers pick who plays from the bench. Organisers, to put Ali K in, tag me and say so, for example *@Match Time put Ali K in*",
    );
    expect(partnerGuestGroupNotice("en", { ...base, kind: "out", organiserPicks: false })).toBe("Ali K from Friday MT Community can no longer play on Tue 27 Oct, 20:00, so I've taken them off.");
  });

  it("TR: the same four", () => {
    expect(partnerGuestGroupNotice("tr", { ...base, kind: "in", organiserPicks: false })).toBe("🙋 Friday MT Community kulübünden Ali K, Tue 27 Oct, 20:00 maçı için kadroya katıldı.");
    expect(partnerGuestGroupNotice("tr", { ...base, kind: "bench", organiserPicks: false })).toBe("🙋 Friday MT Community kulübünden Ali K, Tue 27 Oct, 20:00 maçı için yedekte.");
    expect(partnerGuestGroupNotice("tr", { ...base, kind: "bench", organiserPicks: true })).toBe(
      "🙋 Friday MT Community kulübünden Ali K, Tue 27 Oct, 20:00 maçı için yedekte. Yedeklerden kimin oynayacağını organizatörler seçer. Organizatörler, Ali K kadroya girsin isterseniz beni etiketleyip yazın, örneğin *@Match Time Ali K kadroya girsin*",
    );
    expect(partnerGuestGroupNotice("tr", { ...base, kind: "out", organiserPicks: false })).toBe("Friday MT Community kulübünden Ali K artık Tue 27 Oct, 20:00 maçına gelemiyor, bu yüzden listeden çıkardım.");
  });

  it("every line names the partner club", () => {
    for (const { text } of all) expect(text).toContain("Friday MT Community");
  });

  it("worded for the whole group: never the organisers' words, no standing, no dashes or slashes as separators, bench never waiting list", () => {
    for (const { text } of all) {
      expect(text).not.toMatch(/for you to pick|seçmeniz için|answered your ask|isteğinize/);
      expect(text).not.toMatch(/third there|üçte bir|rated|puanı/);
      expect(text).not.toMatch(/[–—]| \/ /);
      expect(text).not.toMatch(/waiting list|bekleme listesi/i);
    }
  });

  it("only an organiser-pick club's bench post says how an organiser puts him in", () => {
    for (const x of all) expect(/@Match Time/.test(x.text)).toBe(x.kind === "bench" && x.organiserPicks);
  });
});
