/**
 * The line on top of a pool ask asked again once the venue is set
 * (2026-10-28): both languages, the house rules, and the ask's own reply
 * carried underneath unchanged.
 */
import { describe, expect, it } from "vitest";
import { poolAskRetryEn } from "../pool-ask-retry.en";
import { POOL_ASK_RETRY_TABLES, askRetryCopy, venueSetRetryText } from "../pool-ask-retry";

const KEYS = Object.keys(poolAskRetryEn);

describe("pool ask retry copy", () => {
  it("every key in every table, Turkish never the English", () => {
    for (const table of Object.values(POOL_ASK_RETRY_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(POOL_ASK_RETRY_TABLES.tr[k as keyof typeof poolAskRetryEn]).not.toBe(poolAskRetryEn[k as keyof typeof poolAskRetryEn]);
  });

  it("house rules: no em or en dash, no slash, no waiting list", () => {
    for (const table of Object.values(POOL_ASK_RETRY_TABLES)) {
      for (const s of Object.values(table)) {
        expect(s).not.toMatch(/[–—]/);
        expect(s).not.toMatch(/\//);
        expect(s).not.toMatch(/waiting list|bekleme listesi/i);
      }
    }
  });

  it("anything unknown is English", () => {
    expect(askRetryCopy("de")).toBe(poolAskRetryEn);
    expect(askRetryCopy("TR")).toBe(POOL_ASK_RETRY_TABLES.tr);
  });

  it("asked: the reason line, then the ask's own reply", () => {
    const reply = "🔎 Asking nearby players from the MatchTime player pool for 2 places on Friday 30 October, 19:00. I'll let you know when one takes a place.";
    expect(venueSetRetryText("en", { asked: true, replyText: reply })).toBe(`Your pitch is set, so I've asked the player pool now:\n${reply}`);
    expect(venueSetRetryText("tr", { asked: true, replyText: "x" })).toBe("Sahanız kaydedildi, oyuncu havuzuna şimdi sordum:\nx");
  });

  it("refused again: a different reason line, the refusal underneath", () => {
    expect(venueSetRetryText("en", { asked: false, replyText: "No pool players are near enough." })).toBe(
      "Your pitch is set, so I tried the player pool again:\nNo pool players are near enough.",
    );
    expect(venueSetRetryText("tr", { asked: false, replyText: "y" })).toBe("Sahanız kaydedildi, oyuncu havuzuna yeniden sormayı denedim:\ny");
  });
});
