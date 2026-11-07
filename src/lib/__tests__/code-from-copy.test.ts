/**
 * THE CODE PAGES NAME THE NUMBER THE CODE COMES FROM (WhatsApp Cloud API
 * plan, PR C7a, section 3.1). After a code is queued for the official
 * number, /login, /signup and /claim add one line naming it, in the
 * browser's language, which stays true when the code is handed to the
 * club number (review of #556, S3). With the flags off nothing is added (the action's
 * answer carries no number), so the pages read exactly as before.
 *
 * Pure: the string tables only. No network, no model, $0.
 */
import { describe, expect, it } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

// Review of #556, S3: the line is shown when the code was queued for the
// official number, but a code that number cannot deliver is handed to the
// club number (decision 5). The line must be true either way: usually the
// official number, otherwise the chat he already has with MatchTime.
describe("code_sent_from: the official number named, and true after a handover too", () => {
  it("English", () => {
    expect(en.code_sent_from({ number: "+447700900999" })).toBe(
      "The code usually comes from MatchTime's official WhatsApp number, +447700900999. If it isn't there, check your chat with MatchTime.",
    );
  });

  it("Turkish", () => {
    expect(tr.code_sent_from({ number: "+447700900999" })).toBe(
      "Kod genelde MatchTime'ın resmi WhatsApp numarasından (+447700900999) gelir. Orada yoksa MatchTime ile olan sohbetinize bakın.",
    );
  });

  it("house rules: no dashes, never 'bot'", () => {
    for (const s of [en.code_sent_from({ number: "+1" }), tr.code_sent_from({ number: "+1" })]) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).not.toMatch(/\bbot\b/i);
    }
  });
});
