/** Quiet hours by WhatsApp: the copy obeys the house rules in both languages. */
import { describe, it, expect } from "vitest";
import { quietHoursWordsCopy } from "../quiet-hours-words";

const URL = "https://matchtime.ai/admin/settings#quiet-hours";
const render = (lang: "en" | "tr"): string[] => {
  const c = quietHoursWordsCopy(lang);
  return [
    c.off({ released: 0 }),
    c.off({ released: 1 }),
    c.off({ released: 4 }),
    c.on({ from: "22:00", to: "08:00", released: 0 }),
    c.on({ from: "22:00", to: "08:00", released: 2 }),
    c.alreadyOff,
    c.alreadyOn({ from: "23:00", to: "09:00" }),
    c.badTime({ url: URL }),
    c.sameTime({ url: URL }),
  ];
};

describe("quiet hours by WhatsApp copy", () => {
  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    for (const line of render(lang)) {
      expect(line).not.toMatch(/[–—]/);
      expect(line.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is never the English", () => {
    const en = render("en");
    render("tr").forEach((line, i) => expect(line).not.toBe(en[i]));
  });

  it("the times are named, and the released count in plain words", () => {
    const [, one, four, on, onReleased] = render("tr");
    expect(one).toBe("✅ Sessiz saatler kapalı. Beklettiğim mesaj şimdi gidiyor.");
    expect(four).toBe("✅ Sessiz saatler kapalı. Beklettiğim 4 mesaj şimdi gidiyor.");
    expect(on).toBe("✅ Sessiz saatler açık: 22:00 ile 08:00 arası. Bu saatlerde mesajlarımı bekletirim.");
    expect(onReleased).toMatch(/\nBeklettiğim 2 mesaj şimdi gidiyor\.$/);
  });
});
