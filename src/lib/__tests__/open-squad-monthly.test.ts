/**
 * OPEN SQUAD ON A MONTHLY CLUB (2026-11-17, the Vets).
 *
 * Mon 23 Nov: 12 monthly regulars and "Pay as you go: 13. Zeeshan", then
 * "1 place open, £8. Say IN to take it." With no limit there are no places
 * open: the list keeps the squad and pay-as-you-go sections, and the
 * places line becomes a short invitation to anyone else, price kept. No
 * "The squad is full." ever, no bench, no format in the title, and every
 * regular is seeded however many there are.
 */
import { describe, it, expect } from "vitest";
import { buildWeekListPost } from "../monthly-week-copy";
import { buildWeekList, decideMonthlySeed, type WeekMember, type WeekRow } from "../monthly-week-rules";
import { monthlyPlacesOpen } from "../monthly-week-asks-rules";

// Monday 23 November 2026, 20:15 London (GMT).
const MATCH = new Date("2026-11-23T20:15:00.000Z");
const NAMES = ["Abid", "Babar", "Chris", "Dan", "Eli", "Faris", "Gus", "Hamid", "Imran", "Jon", "Kev", "Liam"];

const regular = (i: number): WeekMember => ({
  userId: `r${i}`,
  name: `${NAMES[i]} Smith`,
  kind: "regular",
  slot: i + 1,
  paid: "claimed",
  absent: false,
  paygDated: false,
});
const REGULARS = NAMES.map((_, i) => regular(i));
const in_ = (userId: string, position: number, name = ""): WeekRow => ({ userId, name, status: "CONFIRMED", position });

const twelvePlusZeeshan: WeekRow[] = [...REGULARS.map((m, i) => in_(m.userId, i + 1, m.name)), { userId: "z", name: "Zeeshan Ali", status: "CONFIRMED", position: 13 }];

describe("the week's list with no limit", () => {
  it("has no places open, however many are in", () => {
    expect(buildWeekList({ members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 14, openSquad: true }).open).toBe(0);
    const twenty = [...twelvePlusZeeshan, ...Array.from({ length: 7 }, (_, i) => in_(`g${i}`, 14 + i))];
    const list = buildWeekList({ members: REGULARS, rows: twenty, maxPlayers: 14, openSquad: true });
    expect(list.open).toBe(0);
    expect(list.slots.filter((s) => s.userId !== null)).toHaveLength(20);
  });

  it("English: the squad, pay as you go, and an invitation in place of \"1 place open\"; no format in the title", () => {
    const list = buildWeekList({ members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 14, openSquad: true });
    const text = buildWeekListPost({ list, matchDate: MATCH, title: "Football", paygPricePence: 800, openSquad: true, lang: "en" });
    expect(text).toBe(
      [
        "📋 *Football, Mon 23 Nov at 20:15*",
        "",
        "*November squad:*",
        ...NAMES.map((n, i) => `${i + 1}. ${n}`),
        "",
        "*Pay as you go:*",
        "13. Zeeshan",
        "Anyone else, say *IN* to play, £8.",
        "",
        "You're all in, no need to say anything. Can't make it? Say *Out*.",
      ].join("\n"),
    );
    expect(text).not.toMatch(/place open|places open|squad is full|bench|a-side/i);
  });

  it("Turkish", () => {
    const list = buildWeekList({ members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 14, openSquad: true });
    const text = buildWeekListPost({ list, matchDate: MATCH, title: "futbol", paygPricePence: 800, openSquad: true, lang: "tr" });
    expect(text).toContain("*Maç başı ödeyenler:*\n13. Zeeshan\nBaşka gelmek isteyen *VARIM* yazsın, £8.");
    expect(text).toContain("Hepiniz listedesiniz, bir şey yazmanıza gerek yok. Gelemeyecek olan *YOKUM* yazsın.");
    expect(text).not.toMatch(/yer boş|Kadro tam|Yedek/);
  });

  it("with no pay-as-you-go player yet, the invitation stands under its heading; below the minimum it says how many more", () => {
    const rows = REGULARS.slice(0, 10).map((m, i) => in_(m.userId, i + 1));
    const list = buildWeekList({ members: REGULARS.slice(0, 10), rows, maxPlayers: 14, openSquad: true });
    const en = buildWeekListPost({ list, matchDate: MATCH, title: "Football", paygPricePence: 800, openSquad: true, short: 2, lang: "en" });
    expect(en).toContain("*Pay as you go:* 2 more needed to play. Anyone else, say *IN* to play, £8.");
    const tr = buildWeekListPost({ list, matchDate: MATCH, title: "futbol", paygPricePence: null, openSquad: true, short: 2, lang: "tr" });
    expect(tr).toContain("*Maç başı ödeyenler:* Oynamak için 2 kişi daha lazım. Başka gelmek isteyen *VARIM* yazsın.");
  });

  it("the compact 17:00 form: title and the invitation, never \"The squad is full.\"", () => {
    const list = buildWeekList({ members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 13, openSquad: true });
    const text = buildWeekListPost({ list, matchDate: MATCH, title: "Football", paygPricePence: 800, openSquad: true, compact: true, lang: "en" });
    expect(text).toBe(["📋 *Football, Mon 23 Nov at 20:15*", "", "*Pay as you go:* Anyone else, say *IN* to play, £8."].join("\n"));
  });

  it("off: today's wording exactly", () => {
    const list = buildWeekList({ members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 14 });
    expect(list.open).toBe(1);
    expect(buildWeekListPost({ list, matchDate: MATCH, title: "Football 7-a-side", paygPricePence: 800, lang: "en" })).toContain(
      "13. Zeeshan\n1 place open, £8. Say *IN* to take it.",
    );
  });
});

describe("the month's seed with no limit", () => {
  it("puts every regular in, past the format's places, and nobody on the waiting list", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ ...regular(i % 12), userId: `r${i}`, slot: i + 1 }));
    const seed = decideMonthlySeed({ members: sixteen, targetRows: [], maxPlayers: Number.POSITIVE_INFINITY });
    expect(seed.write.filter((w) => w.status === "CONFIRMED")).toHaveLength(16);
    expect(seed.write.filter((w) => w.status === "BENCH")).toHaveLength(0);
    expect(seed.bump).toHaveLength(0);
  });
});

describe("what a pool or partner ask may ask for in a monthly week", () => {
  const week = { members: REGULARS, rows: twelvePlusZeeshan, maxPlayers: 14, seeded: true };
  it("no limit: nothing at or above the minimum, the shortfall below it", () => {
    expect(monthlyPlacesOpen({ ...week, openSquad: true, minimum: 12 })).toBe(0);
    expect(monthlyPlacesOpen({ ...week, rows: twelvePlusZeeshan.slice(0, 9), openSquad: true, minimum: 12 })).toBe(3);
  });
  it("off: the places open, as before", () => {
    expect(monthlyPlacesOpen(week)).toBe(1);
  });
});
