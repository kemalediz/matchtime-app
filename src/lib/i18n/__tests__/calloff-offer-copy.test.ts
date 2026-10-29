/**
 * The DM to an organiser who called the game off without a tag, and the
 * replies to his answer: both languages and the house rules.
 */
import { describe, expect, it } from "vitest";
import { calloffOfferEn } from "../calloff-offer.en";
import { CALLOFF_OFFER_TABLES, calloffCopy } from "../calloff-offer";

const KEYS = Object.keys(calloffOfferEn) as Array<keyof typeof calloffOfferEn>;
const sample = (s: unknown) => (typeof s === "function" ? (s as unknown as (p: Record<string, string>) => string)({ day: "Monday", game: "Vets MNF, Mon 26 Oct at 20:30" }) : String(s));

describe("call-off offer copy", () => {
  it("every key in every table, Turkish never the English", () => {
    for (const table of Object.values(CALLOFF_OFFER_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(sample(CALLOFF_OFFER_TABLES.tr[k])).not.toBe(sample(calloffOfferEn[k]));
  });

  it("house rules: no em or en dash, no slash, no waiting list", () => {
    for (const table of Object.values(CALLOFF_OFFER_TABLES)) {
      for (const s of Object.values(table)) {
        const text = sample(s);
        expect(text).not.toMatch(/[–—]/);
        expect(text).not.toMatch(/\//);
        expect(text).not.toMatch(/waiting list|bekleme listesi/i);
      }
    }
  });

  it("the offer, word for word", () => {
    expect(calloffCopy("en").offer({ day: "Monday" })).toBe(
      "Sounds like Monday is off. Reply *cancel* and I'll cancel it and tell the group, or ignore this if it's still on.",
    );
    expect(calloffCopy("tr").offer({ day: "Pazartesi" })).toBe(
      "Pazartesi maçı yapılmayacak gibi görünüyor. *iptal* yazarsan maçı iptal edip gruba haber veririm. Maç hâlâ yapılıyorsa bu mesajı boş ver.",
    );
  });

  it("anything unknown is English", () => {
    expect(calloffCopy("de")).toBe(calloffOfferEn);
    expect(calloffCopy("TR")).toBe(CALLOFF_OFFER_TABLES.tr);
  });
});
