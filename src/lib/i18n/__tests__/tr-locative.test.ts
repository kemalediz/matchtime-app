import { describe, expect, it } from "vitest";
import { trLocative } from "../tr-locative";

describe("trLocative: the Turkish 'at, on, in' ending after a number", () => {
  it("times: read as hour, then minutes when there are any", () => {
    expect(trLocative("09:00")).toBe("09:00'da"); // dokuz
    expect(trLocative("10:00")).toBe("10:00'da"); // on
    expect(trLocative("11:00")).toBe("11:00'de"); // on bir
    expect(trLocative("13:00")).toBe("13:00'te"); // on üç
    expect(trLocative("14:00")).toBe("14:00'te"); // on dört
    expect(trLocative("16:00")).toBe("16:00'da"); // on altı
    expect(trLocative("20:00")).toBe("20:00'de"); // yirmi
    expect(trLocative("00:00")).toBe("00:00'da"); // sıfır
    expect(trLocative("09:30")).toBe("09:30'da"); // otuz
    expect(trLocative("09:15")).toBe("09:15'te"); // on beş
    expect(trLocative("09:40")).toBe("09:40'ta"); // kırk
    expect(trLocative("09:45")).toBe("09:45'te"); // kırk beş
    expect(trLocative("09:50")).toBe("09:50'de"); // elli
  });

  it("dates: read by the year", () => {
    expect(trLocative("28 Eki 2026")).toBe("28 Eki 2026'da"); // altı
    expect(trLocative("1 Oca 2027")).toBe("1 Oca 2027'de"); // yedi
    expect(trLocative("1 Oca 2030")).toBe("1 Oca 2030'da"); // otuz
    expect(trLocative("1 Oca 2000")).toBe("1 Oca 2000'de"); // bin
    expect(trLocative("1 Oca 2100")).toBe("1 Oca 2100'de"); // yüz
    expect(trLocative("1 Oca 2060")).toBe("1 Oca 2060'ta"); // altmış
  });

  it("no number at the end: no ending to compute, the text as it came", () => {
    expect(trLocative("yarın")).toBe("yarın");
  });
});
