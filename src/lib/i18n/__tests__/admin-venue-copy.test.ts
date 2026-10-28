/** The pitch-by-WhatsApp copy obeys the house rules in both languages. */
import { describe, it, expect } from "vitest";
import { adminVenueCopy } from "../admin-venue";

const render = (lang: "en" | "tr"): string[] => {
  const c = adminVenueCopy(lang);
  return [
    c.set({ name: "Goals Sutton", address: "Oxford Rd, Sutton SM1 2AA, UK", url: "https://matchtime.ai/admin/settings#club-venue" }),
    c.set({ name: "Goals Sutton", address: "", url: "https://matchtime.ai/admin/settings#club-venue" }),
    c.which({ words: "Goals", options: ["Goals Sutton, Sutton", "Goals Wimbledon, London"] }),
    c.none({ words: "Goals Sutton", url: "https://matchtime.ai/admin/settings#club-venue" }),
    c.unavailable({ url: "https://matchtime.ai/admin/settings#club-venue" }),
    c.noName,
    c.nothingToRetry,
  ];
};

describe("admin venue copy", () => {
  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    for (const line of render(lang)) {
      expect(line).not.toMatch(/[–—]/);
      // A slash only inside a URL.
      expect(line.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is never the English", () => {
    const en = render("en");
    render("tr").forEach((line, i) => expect(line).not.toBe(en[i]));
  });

  it("the set line names the place and its address; the list is numbered from 1", () => {
    expect(render("en")[0]).toContain("*Goals Sutton*, Oxford Rd, Sutton SM1 2AA, UK");
    expect(render("en")[1]).toContain("*Goals Sutton*.");
    expect(render("en")[2]).toMatch(/\n1\. Goals Sutton, Sutton\n2\. Goals Wimbledon, London\n/);
    expect(render("tr")[2]).toMatch(/\n1\. Goals Sutton, Sutton\n2\. Goals Wimbledon, London\n/);
  });
});
