/**
 * THE GROUP LINE THAT SAYS A PLAYER'S STATS WENT BY DM (2026-09-23).
 *
 * "@Match Time what is my rating?" DMs the asker their personal stats
 * link. Until today the group saw only a 📊 react, and Kemal (an admin)
 * did not realise a DM had gone out: "It's better to say a line that the
 * stats went by DM rather than a stats icon." So the group now gets one
 * short line, addressed to the asker, and no react.
 *
 * What these tests pin:
 *   - the exact words, in both languages;
 *   - the privacy rule: the line carries no number, rating or stat, only
 *     that the stats are on their way privately;
 *   - it does not claim delivery: the DM is a queued BotJob the Pi sends a
 *     moment later, so the line says "I'm sending", never "I've sent";
 *   - it cannot be mistaken for a squad post by the composition pass, and
 *     the route skips it by intent anyway.
 */
import { describe, expect, it } from "vitest";
import {
  buildStatsLinkSentLine,
  composeSquadStateReply,
  displaysSquadState,
  skipsSquadComposition,
  type SquadTruth,
} from "../group-copy";

describe("buildStatsLinkSentLine", () => {
  it("English: addresses the asker by first name and says the stats are coming by DM", () => {
    expect(buildStatsLinkSentLine({ name: "Erdal Yilmaz", lang: "en" })).toBe(
      "📊 Erdal, I'm sending your stats to you privately by DM.",
    );
  });

  it("Turkish: the same line, addressed the same way", () => {
    expect(buildStatsLinkSentLine({ name: "Erdal Yılmaz", lang: "tr" })).toBe(
      "📊 Erdal, istatistiklerini sana özel mesajla gönderiyorum.",
    );
  });

  it("no usable name: the line still reads, without one", () => {
    expect(buildStatsLinkSentLine({ name: null, lang: "en" })).toBe(
      "📊 I'm sending your stats to you privately by DM.",
    );
    expect(buildStatsLinkSentLine({ name: "   ", lang: "tr" })).toBe(
      "📊 İstatistiklerini sana özel mesajla gönderiyorum.",
    );
  });

  it("a name that is really a phone number is never printed in the group", () => {
    for (const lang of ["en", "tr"] as const) {
      const line = buildStatsLinkSentLine({ name: "+44 7700 900003", lang });
      expect(line).toBe(buildStatsLinkSentLine({ name: null, lang }));
    }
  });

  it("carries no number, rating or stat in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const line = buildStatsLinkSentLine({ name: "Erdal", lang });
      expect(line, lang).not.toMatch(/\d/);
      expect(line, lang).not.toMatch(/https?:\/\//);
    }
  });

  it("does not claim delivery: 'sending', never 'sent'", () => {
    expect(buildStatsLinkSentLine({ name: "Erdal", lang: "en" })).not.toMatch(/\b(sent|DM'd|delivered)\b/i);
    expect(buildStatsLinkSentLine({ name: "Erdal", lang: "tr" })).not.toMatch(/gönderdim|ulaştı/i);
  });

  it("no em dash or en dash in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      expect(buildStatsLinkSentLine({ name: "Erdal", lang }), lang).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("the line is never recomposed into the squad", () => {
  const truth: SquadTruth = {
    confirmed: ["Erdal Yilmaz", "Sait Demir"],
    bench: [],
    maxPlayers: 14,
    knownNames: ["Erdal Yilmaz", "Sait Demir"],
  };

  it("by intent: `stats_link` is skipped by the composition pass", () => {
    expect(skipsSquadComposition("stats_link")).toBe(true);
  });

  it("by shape: the line does not display or contradict squad state, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const line = buildStatsLinkSentLine({ name: "Erdal Yilmaz", lang });
      expect(displaysSquadState(line, lang), lang).toBe(false);
      expect(composeSquadStateReply(line, truth, lang), lang).toEqual({ text: line, composed: false });
    }
  });
});
