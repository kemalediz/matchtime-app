/**
 * THE SHAPE OF A MONTHLY LIST (types only, 2026-10-29).
 *
 * A monthly club (Vets MNF) runs on a numbered list for the month, re-pasted
 * all month with notes beside the names. Since 2026-10-29 it is READ by the
 * monthly reader, a model step (`monthly-reader.ts`, Kemal: no code reads
 * what people mean, the numbering and headers included). This file holds
 * only what that reading is: the lines, their marks and the facts the model
 * gave about each.
 *
 * The deterministic parser that used to live here is kept only as a test
 * fixture (`__tests__/fixtures/monthly-legacy.ts`), and a source guard
 * (`__tests__/monthly-no-parsing.source.test.ts`) keeps every production
 * file away from it.
 *
 * A "(paid)" mark is a CLAIM written by whoever pasted the list. It is
 * never proof of payment.
 */
/** A date a PAYG player named: "5th" is `{ day: 5, month: null }`,
 *  "9 Kasım" is `{ day: 9, month: 11 }`. The month is 1 to 12, and null
 *  means "of the list's month". */
export interface PaygDate {
  day: number;
  month: number | null;
}

export interface MonthlyListMarks {
  /** The line carries a paid mark: "(paid)", "paid", "(Paid £22.50)",
   *  "ödedi". A claim, never a confirmation. */
  paid: boolean;
  /** The amount written with the paid mark, in pence ("£22.50" is 2250).
   *  Null when no amount is written. */
  paidAmountPence: number | null;
  /** "(paid pensioners rate)", "(paid concession)", "(OAP)". A hint for
   *  the organiser to confirm, never applied on its own. */
  tier: "concession" | null;
  /** "(PAYG)": pays per game, not for the month. */
  payg: boolean;
  /** The dates a PAYG mark names. Empty for a plain "(PAYG)". */
  paygDates: PaygDate[];
  /** "4 only": the games of the month this person commits to, as the
   *  monthly reader (the model) read it. Absent from a list parsed here. */
  gamesCommitted?: number | null;
}

export interface MonthlyListEntry {
  /** The number as written. Never renumbered: slot numbers are stable
   *  through the month, and a gap is information. Null for a bullet. */
  slot: number | null;
  /** The line with its numbering removed, otherwise untouched. */
  raw: string;
  /** The cleaned name with the marks taken out. Empty for a blank slot. */
  name: string;
  marks: MonthlyListMarks;
  /** What the monthly READER (the model, `monthly-reader.ts`) said about
   *  the line beyond its marks. Absent from a list this file parsed. */
  facts?: MonthlyLineFacts;
}

/** The model's facts about one line, checked against the context it was
 *  shown (`parseMonthlyReading`). */
export interface MonthlyLineFacts {
  /** The member the line is, when it is one of them. */
  memberId: string | null;
  /** Somebody who is not a member, brought along by a member. */
  guest: boolean;
  /** Whose guest, when the line or the chat says. */
  hostUserId: string | null;
  /** "4 only": the games this person commits to for the month. */
  games: number | null;
  /** A hint that this is somebody new to the club. Never applied alone. */
  newbie: boolean;
}

export interface MonthlyListMonth {
  /** 1 to 12. */
  month: number;
  /** Only when the header writes one ("List for January 2027"). */
  year: number | null;
}

export interface MonthlyList {
  /** From "List for October", "October list", "Ekim listesi". Null when
   *  the message has no such header. */
  month: MonthlyListMonth | null;
  /** The playing list, in the order written. Blank slots are kept. */
  slots: MonthlyListEntry[];
  sections: {
    /** "Paid but can't play", "Can't play", "Out", "Injured",
     *  "Gelemeyenler", "Ödedi gelemiyor". */
    cantPlay: MonthlyListEntry[];
    /** "Reserves", "Subs", "Standby". */
    reserves: MonthlyListEntry[];
    /** Under a header this reader does not know, where the numbering
     *  started again. Kept apart so it is never mistaken for slots. */
    other: MonthlyListEntry[];
  };
}
