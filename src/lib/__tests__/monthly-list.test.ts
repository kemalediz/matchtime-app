/**
 * The monthly list reader (monthly squad plan, slice 1, section 6.1).
 *
 * Pure and deterministic: no model, no database, nothing posts. The
 * fixtures are anonymised lists in the style a real group writes them.
 */
import { describe, it, expect } from "vitest";
import {
  parseMonthlyList,
  readMarks,
  findInMonthlyList,
  type MonthlyListEntry,
} from "../monthly-list";
import { parsePastedRoster } from "../pasted-roster";
import f3Fixture from "../setup-learning/__fixtures__/monthly-list.json";
import {
  OPENING_POST,
  SIGN_UP,
  MATCH_DAY,
  TWO_SECTIONS,
  TURKISH,
  MATCHTIME_POST,
} from "./monthly-list.fixtures";

const bySlot = (entries: MonthlyListEntry[], slot: number): MonthlyListEntry => {
  const e = entries.find((x) => x.slot === slot);
  if (!e) throw new Error(`no slot ${slot}`);
  return e;
};

describe("parseMonthlyList: the month header", () => {
  it.each([
    ["List for October:", 10],
    ["list for november", 11],
    ["October list", 10],
    ["Oct list:", 10],
    ["*List for December*", 12],
    ["📋 List for November (5 Mondays: 2, 9, 16, 23, 30)", 11],
    ["📋 List for October: Mon 12 Oct, 20:00", 10],
    ["📋 List for November: £7.50 a game, pay Sam by Fri 30 Oct", 11],
    ["List for May", 5],
    ["Ekim listesi", 10],
    ["Kasım listesi", 11],
    ["Aralık ayı listesi", 12],
    ["Şubat listesi:", 2],
  ])("%s", (header, month) => {
    const r = parseMonthlyList(`${header}\n\n1. Marco\n2. Gary\n3. JB\n4. Clive`);
    expect(r?.month?.month).toBe(month);
  });

  it("reads a year when one is written", () => {
    const r = parseMonthlyList("List for January 2027\n1. Marco\n2. Gary\n3. JB\n4. Clive");
    expect(r?.month).toEqual({ month: 1, year: 2027 });
  });

  it("a list with no month header still parses, with month null", () => {
    const r = parseMonthlyList("1. Marco\n2. Gary (paid)\n3. JB\n4. Clive");
    expect(r).not.toBeNull();
    expect(r!.month).toBeNull();
  });

  it("a header that only mentions a month, with no list word, is not a month header", () => {
    const r = parseMonthlyList("See you in October lads\n1. Marco\n2. Gary\n3. JB\n4. Clive");
    expect(r!.month).toBeNull();
  });

  it("a player called Martin is not the month of March", () => {
    const r = parseMonthlyList("Martin's list\n1. Marco\n2. Gary\n3. JB\n4. Clive");
    expect(r!.month).toBeNull();
  });

  it("'the list may change' does not make it May when a real month is named", () => {
    const r = parseMonthlyList(
      "The list may change for October\n1. Marco\n2. Gary\n3. JB\n4. Clive",
    );
    expect(r!.month?.month).toBe(10);
  });
});

describe("parseMonthlyList: what is and is not a list", () => {
  it("prose is not a list", () => {
    expect(parseMonthlyList("£22.50 for 4 games next month, pay by Friday")).toBeNull();
    expect(parseMonthlyList("")).toBeNull();
    expect(parseMonthlyList(null)).toBeNull();
  });

  it("a month header with a short list is a list (the organiser's opening post)", () => {
    const r = parseMonthlyList(OPENING_POST);
    expect(r).not.toBeNull();
    expect(r!.month?.month).toBe(10);
    expect(r!.slots.map((s) => [s.slot, s.name])).toEqual([
      [1, "Marco"],
      [2, "Gary"],
      [3, "JB"],
      [4, ""],
    ]);
  });

  it("with no month header, the pasted-roster thresholds apply", () => {
    expect(parseMonthlyList("1. Marco\n2. Gary")).toBeNull();
    expect(parseMonthlyList("next month\n\n1.Marco")).toBeNull();
  });

  it("a month header with no numbered line is not a list", () => {
    expect(parseMonthlyList("List for October will go up tonight")).toBeNull();
  });
});

describe("parseMonthlyList: slots", () => {
  it("reads the sign-up list: names cleaned, slot numbers as written", () => {
    const r = parseMonthlyList(SIGN_UP)!;
    expect(r.slots.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.slots.map((s) => s.name)).toEqual([
      "Marco",
      "Gary",
      "JB",
      "Clive",
      "Tom",
      "Paulo",
      "Danny",
      "Simon",
      "Mick",
      "Wes",
      "Sunny",
    ]);
    expect(r.sections.cantPlay).toEqual([]);
    expect(r.sections.reserves).toEqual([]);
  });

  it("reads the full 14-slot match-day list", () => {
    const r = parseMonthlyList(MATCH_DAY)!;
    expect(r.month?.month).toBe(10);
    expect(r.slots).toHaveLength(14);
    expect(r.slots.map((s) => s.name)).toEqual([
      "Marco",
      "Gary",
      "JB",
      "Clive",
      "Tom",
      "Vikram",
      "BoJan",
      "Simon",
      "Mick",
      "",
      "Sunny",
      "Mo",
      "Sam",
      "Alfie",
    ]);
  });

  it("a blank slot is kept, with its number and an empty name", () => {
    const r = parseMonthlyList(MATCH_DAY)!;
    const ten = bySlot(r.slots, 10);
    expect(ten.name).toBe("");
    expect(ten.marks.paid).toBe(false);
    expect(ten.marks.payg).toBe(false);
  });

  it("slot numbers with gaps are kept as written, not renumbered", () => {
    const r = parseMonthlyList("List for October\n1. Marco\n2. Gary\n5. Tom\n9. Mick\n14. Alfie")!;
    expect(r.slots.map((s) => s.slot)).toEqual([1, 2, 5, 9, 14]);
  });

  it("placeholder dots are a blank slot, not a name", () => {
    const r = parseMonthlyList("List for October\n1. Marco\n2. ...\n3. …\n4. -\n5. ?")!;
    expect(r.slots.map((s) => s.name)).toEqual(["Marco", "", "", "", ""]);
  });

  it("an emoji inside a name is dropped from the name", () => {
    const r = parseMonthlyList(MATCH_DAY)!;
    expect(bySlot(r.slots, 7).name).toBe("BoJan");
  });

  it("a bracket outside the vocabulary is ignored, as today", () => {
    const r = parseMonthlyList(MATCH_DAY)!;
    const marco = bySlot(r.slots, 1);
    expect(marco.name).toBe("Marco");
    expect(marco.marks).toEqual({
      paid: false,
      paidAmountPence: null,
      tier: null,
      payg: false,
      paygDates: [],
    });
  });

  it("a WhatsApp id never becomes a name", () => {
    const r = parseMonthlyList("List for October\n1. Marco\n2. @158055467598020\n3. +44 7700 900123")!;
    expect(r.slots.map((s) => s.name)).toEqual(["Marco", "", ""]);
  });

  it("MatchTime's own month post reads back as the list it posted", () => {
    const r = parseMonthlyList(MATCHTIME_POST)!;
    expect(r.month?.month).toBe(11);
    expect(r.slots.map((s) => [s.slot, s.name])).toEqual([
      [1, "Alex"],
      [2, "Bilal"],
      [3, "Chris"],
      [4, ""],
      [5, ""],
    ]);
  });
});

describe("readMarks: paid marks are kept, not thrown away", () => {
  it.each([
    ["Mo (paid)", "Mo", null],
    ["Danny(paid)", "Danny", null],
    ["Nico ( paid )", "Nico", null],
    ["Sunny paid ", "Sunny", null],
    ["Sunny PAID", "Sunny", null],
    ["Gary (Paid £22.50)", "Gary", 2250],
    ["Paulo (paid 22.50)", "Paulo", 2250],
    ["Paulo (paid 22.5)", "Paulo", 2250],
    ["Tom (Paid 30)", "Tom", 3000],
    ["Tom Paid 30", "Tom", 3000],
    ["Tom paid £30", "Tom", 3000],
    ["Tom - paid £37.50", "Tom", 3750],
    ["Tom (paid: £30)", "Tom", 3000],
    ["Tom (£30 paid)", "Tom", 3000],
    ["Emre (ödedi)", "Emre", null],
    ["Emre ödedi", "Emre", null],
    ["Işıl (ödendi)", "Işıl", null],
    ["Burak ödedi 300", "Burak", 30000],
  ])("%s", (raw, name, pence) => {
    const r = readMarks(raw);
    expect(r.name).toBe(name);
    expect(r.marks.paid).toBe(true);
    expect(r.marks.paidAmountPence).toBe(pence);
    expect(r.marks.payg).toBe(false);
  });

  it.each([
    ["Clive (paid pensioners rate)"],
    ["Clive (paid pensioner rate)"],
    ["Clive (paid concession)"],
    ["Clive (paid OAP)"],
  ])("%s is paid with a concession hint", (raw) => {
    const r = readMarks(raw);
    expect(r.name).toBe("Clive");
    expect(r.marks.paid).toBe(true);
    expect(r.marks.tier).toBe("concession");
    expect(r.marks.paidAmountPence).toBeNull();
  });

  it("(OAP) alone is a concession hint and NOT a paid mark", () => {
    const r = readMarks("Clive (OAP)");
    expect(r.name).toBe("Clive");
    expect(r.marks.tier).toBe("concession");
    expect(r.marks.paid).toBe(false);
  });

  it.each([["Jake (not paid)"], ["Jake (unpaid)"], ["Jake not paid"], ["Jake (ödemedi)"]])(
    "%s is not a paid mark",
    (raw) => {
      const r = readMarks(raw);
      expect(r.name).toBe("Jake");
      expect(r.marks.paid).toBe(false);
    },
  );

  it("a number that is not plainly an amount is not read as one", () => {
    expect(readMarks("Tom (paid for 4 games)").marks).toMatchObject({
      paid: true,
      paidAmountPence: null,
    });
  });

  it("a name with no mark has no marks", () => {
    expect(readMarks("Marco")).toEqual({
      name: "Marco",
      marks: { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [] },
    });
  });

  it("a name that merely contains the letters is untouched", () => {
    expect(readMarks("Paidraig").name).toBe("Paidraig");
    expect(readMarks("Paidraig").marks.paid).toBe(false);
  });
});

describe("readMarks: PAYG", () => {
  it.each([["Vikram (PAYG)"], ["Vikram (payg)"], ["Vikram PAYG"], ["Vikram - PAYG"], ["Vikram(PAYG)"]])(
    "%s",
    (raw) => {
      const r = readMarks(raw);
      expect(r.name).toBe("Vikram");
      expect(r.marks.payg).toBe(true);
      expect(r.marks.paygDates).toEqual([]);
      expect(r.marks.paid).toBe(false);
    },
  );

  it.each([
    ["Simon (PAYG 5th only)", [{ day: 5, month: null }]],
    ["Simon PAYG 5th only", [{ day: 5, month: null }]],
    ["Simon (PAYG 9th, 23rd)", [{ day: 9, month: null }, { day: 23, month: null }]],
    ["Simon (PAYG 9th and 23rd)", [{ day: 9, month: null }, { day: 23, month: null }]],
    ["Simon (PAYG 2nd & 16th only)", [{ day: 2, month: null }, { day: 16, month: null }]],
    ["Simon (PAYG 1st)", [{ day: 1, month: null }]],
    ["Çağrı (PAYG 9 Kasım)", [{ day: 9, month: 11 }]],
    ["Simon (PAYG 9 Nov)", [{ day: 9, month: 11 }]],
    ["Simon (PAYG 9th and 23rd Nov)", [{ day: 9, month: 11 }, { day: 23, month: 11 }]],
    ["Simon (PAYG 26th Oct, 2nd Nov)", [{ day: 26, month: 10 }, { day: 2, month: 11 }]],
    ["Simon (PAYG sadece 9 Kasım)", [{ day: 9, month: 11 }]],
  ])("%s", (raw, dates) => {
    const r = readMarks(raw);
    expect(r.name).toBe(raw.startsWith("Ç") ? "Çağrı" : "Simon");
    expect(r.marks.payg).toBe(true);
    expect(r.marks.paygDates).toEqual(dates);
  });

  it("an impossible day is not a date", () => {
    expect(readMarks("Simon (PAYG 45th)").marks.paygDates).toEqual([]);
  });

  it("a date beside a paid mark is a date, not an amount", () => {
    expect(readMarks("Simon (PAYG 5th, paid)").marks).toEqual({
      paid: true,
      paidAmountPence: null,
      tier: null,
      payg: true,
      paygDates: [{ day: 5, month: null }],
    });
  });

  it("a PAYG player can also be marked paid", () => {
    const a = readMarks("Vikram (PAYG) (paid)");
    expect(a.name).toBe("Vikram");
    expect(a.marks).toMatchObject({ payg: true, paid: true });
    const b = readMarks("Vikram (PAYG, paid £8)");
    expect(b.name).toBe("Vikram");
    expect(b.marks).toMatchObject({ payg: true, paid: true, paidAmountPence: 800, paygDates: [] });
    const c = readMarks("Vikram PAYG paid");
    expect(c.name).toBe("Vikram");
    expect(c.marks).toMatchObject({ payg: true, paid: true });
  });
});

describe("parseMonthlyList: marks on the match-day list", () => {
  const r = parseMonthlyList(MATCH_DAY)!;

  it("every paid style on the list is read", () => {
    const paid = r.slots.filter((s) => s.marks.paid).map((s) => [s.name, s.marks.paidAmountPence]);
    expect(paid).toEqual([
      ["Gary", 2250],
      ["JB", 2250],
      ["Clive", null],
      ["Tom", 3000],
      ["BoJan", 2250],
      ["Mick", 2250],
      ["Sunny", null],
      ["Mo", null],
    ]);
  });

  it("the concession hint is read", () => {
    expect(bySlot(r.slots, 4).marks.tier).toBe("concession");
  });

  it("PAYG players and their dates are read", () => {
    const payg = r.slots.filter((s) => s.marks.payg).map((s) => [s.slot, s.name, s.marks.paygDates]);
    expect(payg).toEqual([
      [6, "Vikram", []],
      [8, "Simon", [{ day: 5, month: null }]],
      [13, "Sam", []],
      [14, "Alfie", []],
    ]);
  });
});

describe("parseMonthlyList: sections", () => {
  it("'Paid but can't play' is its own section, never slots", () => {
    const r = parseMonthlyList(MATCH_DAY)!;
    expect(r.sections.cantPlay.map((e) => [e.slot, e.name])).toEqual([
      [1, "Paulo"],
      [2, "Kai"],
      [3, "Finn"],
      [4, "Nico"],
      [5, "Wes"],
    ]);
    const slotNames = r.slots.map((s) => s.name);
    for (const out of ["Paulo", "Kai", "Finn", "Nico", "Wes"]) {
      expect(slotNames).not.toContain(out);
    }
  });

  it("two sections: can't play and reserves", () => {
    const r = parseMonthlyList(TWO_SECTIONS)!;
    expect(r.month?.month).toBe(10);
    expect(r.slots.map((s) => s.name)).toEqual(["Marco", "Gary", "JB", "Clive", "", "Tom"]);
    expect(r.sections.cantPlay.map((e) => e.name)).toEqual(["Paulo", "Kai"]);
    expect(r.sections.reserves.map((e) => e.name)).toEqual(["Theo", "Rafi"]);
  });

  it.each([
    ["Paid but can't play"],
    ["Paid but can’t play:"],
    ["Paid but cant play"],
    ["*Paid but can't play*"],
    ["Paid, can't play"],
    ["Paid but cannot play"],
    ["Can't play"],
    ["Can't make it:"],
    ["Out"],
    ["OUT:"],
    ["Injured"],
    ["Unavailable"],
    ["Not playing"],
    ["Paid but can't play (2)"],
    ["Gelemeyenler"],
    ["Gelemeyenler:"],
    ["Ödedi gelemiyor"],
    ["Ödedi ama gelemiyor"],
  ])("section header: %s", (header) => {
    const r = parseMonthlyList(`List for October\n1. Marco\n2. Gary\n3. JB\n\n${header}\n1. Paulo\n2. Kai`)!;
    expect(r.slots.map((s) => s.name)).toEqual(["Marco", "Gary", "JB"]);
    expect(r.sections.cantPlay.map((e) => e.name)).toEqual(["Paulo", "Kai"]);
  });

  it("a mark inside a section is still read", () => {
    const r = parseMonthlyList(
      "List for October\n1. Marco\n2. Gary\n3. JB\n\nPaid but can't play\n1. Paulo (paid £22.50)",
    )!;
    expect(r.sections.cantPlay[0]).toMatchObject({
      name: "Paulo",
      marks: { paid: true, paidAmountPence: 2250 },
    });
  });

  it("an unknown header whose numbering starts again is kept apart, never read as slots", () => {
    const r = parseMonthlyList("List for October\n1. Marco\n2. Gary\n3. JB\n\nMaybes\n1. Theo\n2. Rafi")!;
    expect(r.slots.map((s) => s.name)).toEqual(["Marco", "Gary", "JB"]);
    expect(r.sections.other.map((e) => e.name)).toEqual(["Theo", "Rafi"]);
    expect(r.sections.cantPlay).toEqual([]);
  });

  it("the Turkish list: marks, a dated PAYG, a blank slot and the section", () => {
    const r = parseMonthlyList(TURKISH)!;
    expect(r.month?.month).toBe(11);
    expect(r.slots.map((s) => [s.slot, s.name])).toEqual([
      [1, "Emre"],
      [2, "Burak"],
      [3, "Çağrı"],
      [4, ""],
      [5, "Işıl"],
    ]);
    expect(bySlot(r.slots, 1).marks.paid).toBe(true);
    expect(bySlot(r.slots, 2).marks).toMatchObject({ paid: true, paidAmountPence: 30000 });
    expect(bySlot(r.slots, 3).marks).toMatchObject({
      payg: true,
      paygDates: [{ day: 9, month: 11 }],
    });
    expect(bySlot(r.slots, 5).marks.paid).toBe(true);
    expect(r.sections.cantPlay.map((e) => e.name)).toEqual(["Deniz", "Ozan"]);
  });
});

describe("findInMonthlyList: by name, not by position", () => {
  const r = parseMonthlyList(MATCH_DAY)!;

  it("finds a player in a slot wherever the slot is", () => {
    expect(findInMonthlyList(r, "Vikram")).toMatchObject({ where: "slot", entry: { slot: 6 } });
    expect(findInMonthlyList(r, "alfie")).toMatchObject({ where: "slot", entry: { slot: 14 } });
  });

  it("matches a fuller member name against the first name on the list", () => {
    expect(findInMonthlyList(r, "Gary Holt")).toMatchObject({ where: "slot", entry: { slot: 2 } });
  });

  it("finds a name through the emoji and the capitals", () => {
    expect(findInMonthlyList(r, "Bojan")).toMatchObject({ where: "slot", entry: { slot: 7 } });
  });

  it("a player under 'Paid but can't play' is found there, not in a slot", () => {
    expect(findInMonthlyList(r, "Paulo")).toMatchObject({ where: "cantPlay", entry: { name: "Paulo" } });
  });

  it("a reserve is found in reserves", () => {
    const two = parseMonthlyList(TWO_SECTIONS)!;
    expect(findInMonthlyList(two, "Theo")).toMatchObject({ where: "reserves" });
  });

  it("someone not on the list is not found", () => {
    expect(findInMonthlyList(r, "Zed")).toBeNull();
    expect(findInMonthlyList(r, "")).toBeNull();
    expect(findInMonthlyList(r, "Garyson")).toBeNull();
  });

  it("the same list in a different order finds the same people", () => {
    const shuffled = parseMonthlyList(
      "List for October\n1. Alfie (PAYG)\n2. Mo (paid)\n3. Gary (Paid £22.50)\n4. Marco",
    )!;
    expect(findInMonthlyList(shuffled, "Gary")?.entry.marks.paidAmountPence).toBe(2250);
    expect(findInMonthlyList(shuffled, "Alfie")?.entry.marks.payg).toBe(true);
  });
});

describe("a whole month of pastes (the anonymised F3 fixture)", () => {
  const pastes = (f3Fixture.history as Array<{ text: string }>)
    .map((m) => m.text)
    .filter((t) => t.startsWith("List for October"));

  it("every paste is read as the October list", () => {
    expect(pastes.length).toBeGreaterThan(25);
    for (const text of pastes) {
      const r = parseMonthlyList(text);
      expect(r, text).not.toBeNull();
      expect(r!.month).toEqual({ month: 10, year: null });
    }
  });

  it("slot numbers always read 1, 2, 3 … as written, and no mark leaks into a name", () => {
    for (const text of pastes) {
      const r = parseMonthlyList(text)!;
      expect(r.slots.map((s) => s.slot)).toEqual(r.slots.map((_, i) => i + 1));
      for (const e of [...r.slots, ...r.sections.cantPlay]) {
        expect(e.name, text).not.toMatch(/paid|payg|[()£\d]/i);
      }
    }
  });

  it("the last paste: 14 slots, one blank, five who paid but can't play", () => {
    const last = parseMonthlyList(pastes[pastes.length - 1])!;
    expect(last.slots).toHaveLength(14);
    expect(last.slots.filter((s) => !s.name).map((s) => s.slot)).toEqual([10]);
    expect(last.sections.cantPlay.map((e) => e.name)).toEqual(["Paulo", "Kai", "Finn", "Nico", "Wes"]);
    expect(last.slots.filter((s) => s.marks.paid)).toHaveLength(8);
    expect(last.slots.filter((s) => s.marks.payg).map((s) => s.name)).toEqual([
      "Vikram",
      "Simon",
      "Sam",
      "Alfie",
    ]);
  });

  it("the same paste through the pasted-roster parser has 13 playing names, not 18", () => {
    const r = parsePastedRoster(pastes[pastes.length - 1])!;
    expect(r.names).toHaveLength(13);
    expect(r.notPlaying.map((e) => e.name)).toEqual(["Paulo", "Kai", "Finn", "Nico", "Wes"]);
  });
});

describe("parseMonthlyList is pure", () => {
  it("same text in, same result out", () => {
    expect(parseMonthlyList(MATCH_DAY)).toEqual(parseMonthlyList(MATCH_DAY));
  });
});
