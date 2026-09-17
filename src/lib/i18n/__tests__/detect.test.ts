/**
 * The language a group speaks, decided BEFORE the bot says its first
 * word, from what it can see when it is added: the group subject and
 * whatever history WhatsApp has synced. Deterministic, no model.
 *
 * The rule is asymmetric on purpose. Turkish has letters English never
 * uses (ğ ş ı İ) and a vocabulary that never appears in an English
 * football chat, so a Turkish group is easy to recognise. The default
 * is English, which is what every group got before this existed, so a
 * mixed or empty picture costs nothing new.
 */
import { describe, it, expect } from "vitest";
import { detectGroupLang, langOfConsentReply } from "../detect";

describe("detectGroupLang: the group subject alone", () => {
  it("a Turkish subject is enough", () => {
    expect(detectGroupLang({ subject: "Cuma Halı Saha ⚽", history: [] }).lang).toBe("tr");
    expect(detectGroupLang({ subject: "Salı Maçı", history: [] }).lang).toBe("tr");
  });

  it("an English subject stays English", () => {
    expect(detectGroupLang({ subject: "Sutton FC Tuesday 7s", history: [] }).lang).toBe("en");
  });

  it("a subject that is only a proper noun decides nothing, so English", () => {
    const r = detectGroupLang({ subject: "Galaxy FC", history: [] });
    expect(r.lang).toBe("en");
    expect(r.confident).toBe(false);
  });
});

describe("detectGroupLang: history", () => {
  const turkish = [
    "hadi çocuklar cuma için kaç kişiyiz",
    "ben varım",
    "yokum bu hafta",
    "saat 21:30 sim arena",
  ];
  const english = ["who's in for tuesday lads", "im in", "out this week sorry", "9pm at goals"];

  it("Turkish messages under a neutral subject", () => {
    const r = detectGroupLang({ subject: "FC", history: turkish });
    expect(r.lang).toBe("tr");
    expect(r.confident).toBe(true);
  });

  it("English messages under a neutral subject", () => {
    const r = detectGroupLang({ subject: "FC", history: english });
    expect(r.lang).toBe("en");
    expect(r.confident).toBe(true);
  });

  it("Turkish typed on an English keyboard (no special letters) still reads as Turkish", () => {
    const r = detectGroupLang({
      subject: null,
      history: ["ben varim", "yokum abi", "cuma saat kacta", "hali saha ayni yer"],
    });
    expect(r.lang).toBe("tr");
  });

  it("a mostly English chat with one Turkish word stays English", () => {
    const r = detectGroupLang({
      subject: "Tuesday Ballers",
      history: [...english, "tamam"],
    });
    expect(r.lang).toBe("en");
  });

  it("nothing to go on: English, not confident", () => {
    const r = detectGroupLang({ subject: null, history: [] });
    expect(r.lang).toBe("en");
    expect(r.confident).toBe(false);
  });

  it("only the most recent messages count (an old English era does not outvote today's Turkish)", () => {
    const old = Array.from({ length: 100 }, () => "in");
    const today = Array.from({ length: 8 }, () => turkish).flat(); // 32 recent Turkish messages
    expect(detectGroupLang({ subject: null, history: [...old, ...today] }).lang).toBe("tr");
    // The same Turkish messages buried under the English era are outvoted.
    expect(detectGroupLang({ subject: null, history: [...today, ...old] }).lang).toBe("en");
  });
});

describe("langOfConsentReply: the answer to the intro says which language the admin speaks", () => {
  it.each(["evet", "EVET", "Evet lütfen", "tamam", "olur", "hadi", "hepsi"])("%j is Turkish", (s) => {
    expect(langOfConsentReply(s)).toBe("tr");
  });
  it.each(["yes", "YES", "yes please", "yeah", "everything", "the lot"])("%j is English", (s) => {
    expect(langOfConsentReply(s)).toBe("en");
  });
  it.each(["", "ok", "👍", "anyone seen my boots"])("%j decides nothing", (s) => {
    expect(langOfConsentReply(s)).toBeNull();
  });
});
