/**
 * Monthly squad, slice 6: the words. English and Turkish, pinned exactly,
 * with no em or en dash anywhere.
 */
import { describe, expect, it } from "vitest";
import {
  buildCancelCreditLine,
  buildLeaverNotice,
  buildMidMonthJoinDm,
  buildMidMonthJoinNotice,
  buildMonthSummaryLines,
  buildMonthSummaryNotice,
  buildShareChangeNotice,
} from "../month-close-copy";
import { summariseMonth } from "../month-close-rules";
import { londonDateTimeToUtc } from "../london-time";

const OCT = new Date("2026-10-01T12:00:00.000Z");
const at = (day: string) => londonDateTimeToUtc(day, "20:00");
const DASH = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
const LINK = "https://matchtime.test/admin/months?month=2026-10-01";

const summary = summariseMonth({
  gamesPlayed: 4,
  regulars: [
    { name: "Alex Carter", amountDuePence: 3000, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
    { name: "Bilal Aydin", amountDuePence: 2250, paid: "confirmed", paidPence: 2250, refundedPence: 0 },
    { name: "Jake Moss", amountDuePence: 2250, paid: "claimed", paidPence: null, refundedPence: 0 },
    { name: "Carl Young", amountDuePence: 3000, paid: "none", paidPence: null, refundedPence: 0 },
    { name: "Dev Patel", amountDuePence: 3200, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
    { name: "Ed Stone", amountDuePence: 2800, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
  ],
  payg: [
    { name: "Omar Khan", date: at("2026-10-12"), feePence: 800, paid: false },
    { name: "Omar Khan", date: at("2026-10-19"), feePence: 800, paid: true },
    { name: "Will Frost", date: at("2026-10-26"), feePence: 800, paid: true },
  ],
  carried: [
    { name: "Sam Hale", games: 1 },
    { name: "Rob Hale", games: 1 },
    { name: "Sam Hale", games: 1 },
  ],
  creditsUsed: 3,
  leavers: [{ name: "Hal Reed", games: 2, pence: 1500 }],
});

describe("the month's summary", () => {
  it("English, line by line", () => {
    expect(buildMonthSummaryLines({ summary, monthDate: OCT, lang: "en" })).toEqual([
      "📒 October summary (4 games played)",
      "Regulars: 6. Paid and confirmed: 4 (£112.50).",
      "Says paid, not confirmed: 1 (Jake Moss £22.50).",
      "Not paid: 1 (Carl Young £30).",
      "Paid, and owe more now: Dev Patel £2.",
      "Paid, with money to come back: Ed Stone £2.",
      "PAYG: 3 games played, £24 (2 paid).",
      "PAYG still to chase: 1 (Omar Khan 12 Oct).",
      "Left part-way and owed: Hal Reed 2 games (£15).",
      "Credits carried to a later month: 3 games (Sam Hale x2, Rob Hale).",
      "Credits used this month: 3 games.",
    ]);
  });

  it("Turkish, line by line", () => {
    expect(buildMonthSummaryLines({ summary, monthDate: OCT, lang: "tr" })).toEqual([
      "📒 Ekim özeti (4 maç oynandı)",
      "Daimi oyuncu: 6. Ödedi ve onaylandı: 4 (£112.50).",
      "Ödediğini söylüyor, onaylanmadı: 1 (Jake Moss £22.50).",
      "Ödemedi: 1 (Carl Young £30).",
      "Ödemiş olup şimdi eksiği olanlar: Dev Patel £2.",
      "Ödemiş olup geri alacağı olanlar: Ed Stone £2.",
      "Maç başı (PAYG): 3 maç oynandı, £24 (2 ödendi).",
      "Maç başı ödemesi beklenenler: 1 (Omar Khan 12 Ekim).",
      "Ay ortasında ayrılan ve alacaklı olanlar: Hal Reed 2 maç (£15).",
      "Sonraki bir aya devreden krediler: 3 maç (Sam Hale x2, Rob Hale).",
      "Bu ay kullanılan krediler: 3 maç.",
    ]);
  });

  it("a quiet month says so plainly", () => {
    const quiet = summariseMonth({ gamesPlayed: 1, regulars: [], payg: [], carried: [], creditsUsed: 0, leavers: [] });
    expect(buildMonthSummaryLines({ summary: quiet, monthDate: OCT, lang: "en" })).toEqual([
      "📒 October summary (1 game played)",
      "Regulars: 0. Paid and confirmed: 0 (£0).",
      "PAYG: no games played.",
      "Credits carried to a later month: none.",
      "Credits used this month: 0 games.",
    ]);
  });

  it("the notice is the lines and the page link", () => {
    const text = buildMonthSummaryNotice({ summary, monthDate: OCT, link: LINK, lang: "en" });
    expect(text.split("\n").at(-1)).toBe(`The full month: ${LINK}`);
    expect(text.startsWith("📒 October summary (4 games played)\n")).toBe(true);
    expect(buildMonthSummaryNotice({ summary, monthDate: OCT, link: "", lang: "en" })).not.toContain("The full month");
  });
});

describe("a cancelled week", () => {
  it("one game, and several", () => {
    expect(buildCancelCreditLine({ count: 1, lang: "en" })).toBe("Regulars get 1 game credit for it.");
    expect(buildCancelCreditLine({ count: 2, lang: "en" })).toBe("Regulars get a game credit for each of the 2 games.");
    expect(buildCancelCreditLine({ count: 1, lang: "tr" })).toBe("Daimi oyunculara 1 maç kredisi yazıldı.");
    expect(buildCancelCreditLine({ count: 2, lang: "tr" })).toBe("Daimi oyunculara iptal edilen 2 maçın her biri için bir maç kredisi yazıldı.");
  });
});

describe("a leaver", () => {
  it("the organisers are told what is owed, and that MatchTime refunds nobody", () => {
    expect(buildLeaverNotice({ name: "Jake Moss", monthDate: OCT, games: 2, pence: 1500, link: LINK, lang: "en" })).toBe(
      `📒 Jake Moss has left October's list after paying. Owed: 2 games (£15).\nMatchTime refunds nobody. Give it back your own way, then record it here: ${LINK}`,
    );
    expect(buildLeaverNotice({ name: "Jake Moss", monthDate: OCT, games: 1, pence: null, link: LINK, lang: "en" })).toContain("Owed: 1 game.");
    expect(buildLeaverNotice({ name: "Jake Moss", monthDate: OCT, games: 2, pence: 1500, link: LINK, lang: "tr" })).toBe(
      `📒 Jake Moss ödeme yaptıktan sonra Ekim listesinden ayrıldı. Alacağı: 2 maç (£15).\nMatchTime kimseye iade yapmaz. Parayı kendi yönteminizle geri verin, sonra buradan kaydedin: ${LINK}`,
    );
  });
});

describe("a share changed after payments", () => {
  const rows = [
    { userId: "a", name: "Alex Carter", amountDuePence: 3200, freezeClaimedPence: null, balancePence: 200 },
    { userId: "e", name: "Ed Stone", amountDuePence: 2400, freezeClaimedPence: null, balancePence: -600 },
    { userId: "c", name: "Carl Young", amountDuePence: 3200, freezeClaimedPence: null, balancePence: 0 },
  ];
  it("says who owes more and who is owed, and that no payment changed", () => {
    expect(buildShareChangeNotice({ rows, sharePence: 800, monthDate: OCT, link: LINK, lang: "en" })).toBe(
      [
        "📋 October: the share is now £8 a game.",
        "Paid already and now owe more: Alex Carter £2.",
        "Paid already and now have money to come back: Ed Stone £6.",
        `Nobody's payment was changed. Settle the difference your own way: ${LINK}`,
      ].join("\n"),
    );
    expect(buildShareChangeNotice({ rows, sharePence: 800, monthDate: OCT, link: LINK, lang: "tr" })).toBe(
      [
        "📋 Ekim: maç başı pay artık £8.",
        "Ödemiş olup şimdi eksiği olanlar: Alex Carter £2.",
        "Ödemiş olup şimdi geri alacağı olanlar: Ed Stone £6.",
        `Kimsenin ödemesi değiştirilmedi. Farkı kendi yönteminizle kapatın: ${LINK}`,
      ].join("\n"),
    );
  });
  it("with nobody affected it says so", () => {
    expect(buildShareChangeNotice({ rows: [rows[2]], sharePence: 800, monthDate: OCT, link: LINK, lang: "en" })).toBe(
      "📋 October: the share is now £8 a game.\nNobody who has paid is affected.",
    );
  });
});

describe("joining part-way", () => {
  it("the player is told the games left and what to pay", () => {
    expect(buildMidMonthJoinDm({ name: "Dev Patel", monthDate: OCT, games: 3, amountDuePence: 2250, collectorName: "Sam Hale", lang: "en" })).toBe(
      '👋 Dev, you are in for the rest of October: 3 games, £22.50. Pay Sam by bank transfer, then DM me "paid".',
    );
    expect(buildMidMonthJoinDm({ name: null, monthDate: OCT, games: 1, amountDuePence: null, collectorName: null, lang: "en" })).toBe(
      "👋 You are in for the rest of October: 1 game. The price follows.",
    );
    expect(buildMidMonthJoinDm({ name: "Dev Patel", monthDate: OCT, games: 3, amountDuePence: 2250, collectorName: "Sam Hale", lang: "tr" })).toBe(
      '👋 Dev, Ekim ayının kalanı için listedesin: 3 maç, £22.50. Ödemeyi havale ile yap (parayı toplayan: Sam), sonra bana "ödedim" yaz.',
    );
  });
  it("the organisers are told once", () => {
    expect(buildMidMonthJoinNotice({ name: "Dev Patel", monthDate: OCT, games: 3, amountDuePence: 2250, link: LINK, lang: "en" })).toBe(
      `📋 Dev Patel joined October part-way: 3 games, £22.50 to pay. ${LINK}`,
    );
  });
});

describe("house style", () => {
  it("no em or en dash in any of it, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const all = [
        ...buildMonthSummaryLines({ summary, monthDate: OCT, lang }),
        buildCancelCreditLine({ count: 1, lang }),
        buildCancelCreditLine({ count: 3, lang }),
        buildLeaverNotice({ name: "Jake", monthDate: OCT, games: 2, pence: 1500, link: LINK, lang }),
        buildShareChangeNotice({ rows: [], sharePence: 800, monthDate: OCT, link: LINK, lang }),
        buildMidMonthJoinDm({ name: "Dev", monthDate: OCT, games: 3, amountDuePence: 2250, collectorName: "Sam", lang }),
        buildMidMonthJoinNotice({ name: "Dev", monthDate: OCT, games: 3, amountDuePence: 2250, link: LINK, lang }),
      ];
      for (const text of all) expect(text, `${lang}: ${text}`).not.toMatch(DASH);
    }
  });
});
