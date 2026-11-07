/**
 * THE CODE PAGES NAME THE NUMBER THE CODE COMES FROM (WhatsApp Cloud API
 * plan, PR C7a, section 3.1). After a code is queued for the official
 * number, /login, /signup and /claim add one line naming it, in the
 * browser's language. With the flags off nothing is added (the action's
 * answer carries no number), so the pages read exactly as before.
 *
 * Pure: the string tables only. No network, no model, $0.
 */
import { describe, expect, it } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

describe("code_sent_from: one line, the official number named", () => {
  it("English", () => {
    expect(en.code_sent_from({ number: "+447700900999" })).toBe("The code comes from MatchTime's official WhatsApp number, +447700900999.");
  });

  it("Turkish", () => {
    expect(tr.code_sent_from({ number: "+447700900999" })).toBe("Kod, MatchTime'ın resmi WhatsApp numarasından geliyor: +447700900999.");
  });

  it("house rules: no dashes, never 'bot'", () => {
    for (const s of [en.code_sent_from({ number: "+1" }), tr.code_sent_from({ number: "+1" })]) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).not.toMatch(/\bbot\b/i);
    }
  });
});
