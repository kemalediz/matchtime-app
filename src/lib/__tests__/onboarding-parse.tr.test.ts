/**
 * The self-setup parsers read Turkish beside English (2026-09-17, the
 * first Turkish group). Every English case in onboarding-parse.test.ts
 * still holds; this file adds the Turkish forms a football group
 * actually types, with and without the special letters (an English
 * keyboard produces "sali" for "salı"), and with the case suffixes
 * Turkish attaches to days and venues. Lower-casing goes through
 * `toLocaleLowerCase("tr")` so "EVET" and "İSTANBUL" are matched.
 */
import { describe, it, expect } from "vitest";
import {
  parseBundleReply,
  parseAdmins,
  RECOMMENDED_BUNDLE,
  EVERYTHING_BUNDLE,
  extractWhenWhere,
  extractDayOfWeek,
  extractKickoffTime,
  extractPlayersPerSide,
  extractRecurrence,
  extractOneOffDate,
  extractVenueFreeText,
  detailsFollowUpQuestion,
  isCancelRequest,
} from "@/lib/onboarding-parse";

// ───────────────────────── consent (introduced stage) ──────────────────

describe("parseBundleReply: Turkish consent", () => {
  it.each(["evet", "EVET", "Evet lütfen", "tamam", "olur", "hadi", "tabii ki", "evet 👍", "Evet!!", "kuralım"])(
    "%j is the recommended bundle",
    (msg) => {
      const r = parseBundleReply(msg);
      expect(r?.choice).toBe("yes");
      expect(r?.features).toEqual(RECOMMENDED_BUNDLE);
    },
  );

  it.each(["hepsi", "her şey", "herşey", "hepsini aç", "hepsi olsun"])("%j is everything", (msg) => {
    const r = parseBundleReply(msg);
    expect(r?.choice).toBe("everything");
    expect(r?.features).toEqual(EVERYTHING_BUNDLE);
  });

  it("everything but payments, in Turkish", () => {
    for (const msg of ["ödeme hariç hepsi", "hepsi ama ödeme olmasın", "ödemesiz hepsi"]) {
      const r = parseBundleReply(msg);
      expect(r?.choice, msg).toBe("everything");
      expect(r?.features, msg).not.toContain("paymentTracking");
      expect(r?.features, msg).toContain("attendance");
    }
  });

  it("a named subset in Turkish", () => {
    const r = parseBundleReply("sadece maçın adamı ve puanlama");
    expect(r?.choice).toBe("custom");
    expect(new Set(r?.features)).toEqual(new Set(["momVoting", "playerRating"]));
  });

  it("a Turkish yes buried in chat is not consent", () => {
    expect(parseBundleReply("evet abi dün maç iyiydi")).toBeNull();
    expect(parseBundleReply("tamam ben cumaya bakarım")).toBeNull();
  });

  it("a Turkish no is not consent either (the bot stays silent)", () => {
    expect(parseBundleReply("hayır")).toBeNull();
    expect(parseBundleReply("yok")).toBeNull();
  });
});

// ───────────────────────── admins stage ────────────────────────────────

describe("parseAdmins: Turkish 'just me' and filler", () => {
  it.each(["sadece ben", "tek ben", "yalnız ben", "ben", "benim", "kimse yok", "başka yok", "başkası yok", "ben hallederim", "sadece ben teşekkürler"])(
    "%j means the owner already covers it",
    (msg) => {
      const r = parseAdmins(msg);
      expect(r.justMe).toBe(true);
      expect(r.admins).toEqual([]);
    },
  );

  it.each(["tamam", "ok", "bilmem", "belki", "hayır", "yok"])("%j is filler, not a name", (msg) => {
    const r = parseAdmins(msg);
    expect(r.admins).toEqual([]);
  });

  it("a Turkish name and number still parse", () => {
    const r = parseAdmins("Erdal Özkan 0532 123 45 67 ve @905321234568");
    expect(r.admins).toHaveLength(2);
    expect(r.admins[0].name).toContain("Erdal");
    expect(r.admins[0].phone).toBeTruthy();
  });
});

// ───────────────────────── days ────────────────────────────────────────

describe("extractDayOfWeek: Turkish day names, with suffixes and without special letters", () => {
  it.each([
    ["pazartesi", 1], ["Pazartesileri", 1], ["pazartesi günü", 1],
    ["salı", 2], ["SALI", 2], ["sali", 2], ["salıları", 2], ["salı günleri", 2],
    ["çarşamba", 3], ["carsamba", 3], ["çarşambaları", 3],
    ["perşembe", 4], ["persembe", 4], ["perşembeleri", 4],
    ["cuma", 5], ["cumaları", 5], ["cuma akşamı", 5], ["her cuma", 5],
    ["cumartesi", 6], ["cumartesileri", 6],
    ["pazar", 0], ["pazarları", 0], ["pazar günü", 0],
  ])("%j is day %i", (text, dow) => {
    expect(extractDayOfWeek(text)).toBe(dow);
  });

  it("cumartesi is not cuma, and pazartesi is not pazar", () => {
    expect(extractDayOfWeek("cumartesi 15:00")).toBe(6);
    expect(extractDayOfWeek("pazartesi 21:00")).toBe(1);
  });

  it("English still wins where English is written", () => {
    expect(extractDayOfWeek("tuesdays 9pm")).toBe(2);
  });
});

// ───────────────────────── times ───────────────────────────────────────

describe("extractKickoffTime: Turkish clock forms", () => {
  it.each([
    ["saat 21:30", "21:30"],
    ["21.30'da", "21:30"],
    ["21:30'da", "21:30"],
    ["saat 9", "09:00"],
    ["akşam 9", "21:00"],
    ["akşam 9'da", "21:00"],
    ["aksam 9 bucukta", "21:30"],
    ["akşam 9 buçukta", "21:30"],
    ["9 buçukta", "09:30"],
    ["akşam 21:30", "21:30"],
    ["gece 10'da", "22:00"],
    ["öğlen 1'de", "13:00"],
    ["sabah 10'da", "10:00"],
    ["saat 20'de", "20:00"],
    ["20'de", "20:00"],
  ])("%j is %s", (text, hhmm) => {
    expect(extractKickoffTime(text)).toBe(hhmm);
  });

  it("a format token is not a time", () => {
    expect(extractKickoffTime("7'ye 7")).toBeNull();
    expect(extractKickoffTime("7ye 7 oynuyoruz")).toBeNull();
  });

  it("English still wins where English is written", () => {
    expect(extractKickoffTime("9:30pm")).toBe("21:30");
  });
});

// ───────────────────────── format ──────────────────────────────────────

describe("extractPlayersPerSide: Turkish format forms", () => {
  it.each([["7'ye 7", 7], ["7ye 7", 7], ["7 ye 7", 7], ["6'ya 6", 6], ["5'e 5", 5], ["8'e 8", 8], ["7v7", 7], ["7'şer kişi", 7], ["7 kişilik takımlar", 7]])(
    "%j is %i a side",
    (text, n) => {
      expect(extractPlayersPerSide(text)).toBe(n);
    },
  );

  it("a clock is not a format", () => {
    expect(extractPlayersPerSide("saat 21:30")).toBeNull();
  });
});

// ───────────────────────── recurrence and dates ────────────────────────

describe("extractRecurrence / extractOneOffDate: Turkish", () => {
  it("weekly", () => {
    expect(extractRecurrence("her hafta cuma")).toBe("weekly");
    expect(extractRecurrence("haftalık")).toBe("weekly");
    expect(extractRecurrence("her cuma 21:30")).toBe("weekly");
  });
  it("one-off", () => {
    expect(extractRecurrence("tek seferlik")).toBe("oneoff");
    expect(extractRecurrence("bir kerelik maç")).toBe("oneoff");
    expect(extractRecurrence("sadece bu hafta")).toBe("oneoff");
  });
  it("numeric day-first dates (both languages write these)", () => {
    expect(extractOneOffDate("18.09.2026")).toBe("2026-09-18");
    expect(extractOneOffDate("18/09/2026")).toBe("2026-09-18");
    expect(extractOneOffDate("2026-09-18")).toBe("2026-09-18");
  });
  it("a Turkish month name with a year", () => {
    expect(extractOneOffDate("18 eylül 2026")).toBe("2026-09-18");
    expect(extractOneOffDate("3 Ekim 2026")).toBe("2026-10-03");
  });
});

// ───────────────────────── venue ───────────────────────────────────────

describe("extractVenueFreeText: Turkish venues", () => {
  it.each([
    ["Sim Arena'da", "Sim Arena"],
    ["cuma 21:30 Sim Arena'da 7'ye 7", "Sim Arena"],
    ["yer: Kadıköy Halı Saha", "Kadıköy Halı Saha"],
    ["Cuma 21:30, Sim Arena, 7'ye 7", "Sim Arena"],
    ["cumaları saat 21:30 Ataşehir Arena sahasında", "Ataşehir Arena"],
    ["Kadıköy halı sahada cuma akşam 9'da", "Kadıköy halı saha"],
  ])("%j reads the venue %j", (text, venue) => {
    expect(extractVenueFreeText(text)).toBe(venue);
  });

  it("a comma-separated English answer without 'at' also finds the venue", () => {
    expect(extractVenueFreeText("Thursdays 9pm, Goals Wembley, 7-a-side")).toBe("Goals Wembley");
  });

  it("nothing venue-like leaves it null", () => {
    expect(extractVenueFreeText("cuma 21:30")).toBeNull();
    expect(extractVenueFreeText("her hafta cuma 7'ye 7")).toBeNull();
    expect(extractVenueFreeText("thursdays 9pm every week")).toBeNull();
  });
});

// ───────────────────────── the combined answer ─────────────────────────

describe("extractWhenWhere: the one Turkish message the intro asks for", () => {
  it('"Cuma 21:30, Sim Arena, 7\'ye 7"', () => {
    const r = extractWhenWhere("Cuma 21:30, Sim Arena, 7'ye 7");
    expect(r.dayOfWeek).toBe(5);
    expect(r.kickoffTime).toBe("21:30");
    expect(r.venue).toBe("Sim Arena");
    expect(r.playersPerSide).toBe(7);
  });

  it('"cumaları akşam 9 buçukta Sim Arena\'da oynuyoruz"', () => {
    const r = extractWhenWhere("cumaları akşam 9 buçukta Sim Arena'da oynuyoruz");
    expect(r.dayOfWeek).toBe(5);
    expect(r.kickoffTime).toBe("21:30");
    expect(r.venue).toBe("Sim Arena");
  });

  it('"her salı saat 20:00 Kadıköy Halı Saha"', () => {
    const r = extractWhenWhere("her salı saat 20:00 Kadıköy Halı Saha");
    expect(r.dayOfWeek).toBe(2);
    expect(r.kickoffTime).toBe("20:00");
    expect(r.venue).toBe("Kadıköy Halı Saha");
    expect(r.recurrence).toBe("weekly");
  });

  it("the English design example is untouched", () => {
    const r = extractWhenWhere("Thursdays 9pm at PowerLeague Shoreditch, 7-a-side");
    expect(r.dayOfWeek).toBe(4);
    expect(r.kickoffTime).toBe("21:00");
    expect(r.venue).toBe("PowerLeague Shoreditch");
    expect(r.playersPerSide).toBe(7);
  });
});

// ───────────────────────── the follow-up question, per language ────────

describe("detailsFollowUpQuestion: Turkish", () => {
  it("all three missing", () => {
    const q = detailsFollowUpQuestion(["day", "time", "venue"], "tr");
    expect(q).toContain("ne zaman ve nerede");
    expect(q).not.toMatch(/[—–]/);
  });
  it("only the gaps", () => {
    const q = detailsFollowUpQuestion(["venue"], "tr");
    expect(q).toContain("saha");
    expect(q).not.toContain("saat");
  });
  it("English default is byte-identical to before", () => {
    expect(detailsFollowUpQuestion(["day"])).toBe(detailsFollowUpQuestion(["day"], "en"));
  });
});

// ───────────────────────── cancelling setup ────────────────────────────

describe("isCancelRequest: an explicit stop ends the session", () => {
  it.each(["@Match Time stop", "@MATCH TIME STOP", "@Match Time cancel", "matchtime cancel setup", "@Match Time iptal", "@MATCH TIME İPTAL", "@Match Time dur", "@Match Time kurulumu iptal et"])(
    "%j cancels",
    (msg) => {
      expect(isCancelRequest(msg)).toBe(true);
    },
  );
  it.each(["stop", "iptal", "cancel the match", "@Match Time who's in", "we should stop losing"])(
    "%j does not (no tag, or not about setup)",
    (msg) => {
      expect(isCancelRequest(msg)).toBe(false);
    },
  );
});
