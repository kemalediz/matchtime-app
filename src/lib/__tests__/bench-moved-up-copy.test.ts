/**
 * What the group and the player are told when the bench fills a place by
 * itself (2026-11-17, `bench-fill.ts`). Pure builders, EN and TR.
 *
 * Never "first to claim": nobody has to race for a place that is already
 * his. The DM tells him he is in and how to give it back.
 */
import { describe, it, expect } from "vitest";
import {
  buildBenchMovedUpLine,
  buildBenchMovedUpDm,
  buildBenchIntroLine,
  buildFullSquadBenchInvite,
  buildSquadCompleteBenchInvite,
} from "@/lib/bench-offer-copy";

describe("the group line", () => {
  it("EN, replacing a named player, with the squad count (the incident)", () => {
    expect(
      buildBenchMovedUpLine({ names: ["Recai Gunay"], droppedName: "David", teamLabel: null, squad: { confirmed: 14, maxPlayers: 14 } }),
    ).toBe("⬆️ *Recai Gunay* moves up from the bench, replacing *David*. Squad *14/14* 🙌");
  });

  it("EN, the same as the lead of the squad-complete post (no count: the header has it)", () => {
    expect(buildBenchMovedUpLine({ names: ["Recai Gunay"], droppedName: "David", teamLabel: null, squad: null })).toBe(
      "⬆️ *Recai Gunay* moves up from the bench, replacing *David* 🙌",
    );
  });

  it("EN, with teams: takes the slot on the team and offers a rebalance", () => {
    const text = buildBenchMovedUpLine({ names: ["Recai"], droppedName: "David", teamLabel: "Reds", squad: { confirmed: 14, maxPlayers: 14 } });
    expect(text.split("\n")[0]).toBe("⬆️ *Recai* moves up from the bench and takes *David*'s place on *Reds* 🙌");
    expect(text).toContain("@Match Time regenerate the teams");
  });

  it("EN, two players, nobody named to replace", () => {
    expect(buildBenchMovedUpLine({ names: ["Ali", "Bilal"], droppedName: null, teamLabel: null, squad: { confirmed: 13, maxPlayers: 14 } })).toBe(
      "⬆️ *Ali* and *Bilal* move up from the bench. Squad *13/14* 🙌",
    );
  });

  it("TR, replacing a named player, with the count", () => {
    expect(
      buildBenchMovedUpLine({ names: ["Recai Gunay"], droppedName: "David", teamLabel: null, squad: { confirmed: 14, maxPlayers: 14 }, lang: "tr" }),
    ).toBe("⬆️ *Recai Gunay* yedekten kadroya geçti, *David* yerine oynuyor, kadro *14/14* 🙌");
  });

  it("TR, with teams", () => {
    const text = buildBenchMovedUpLine({ names: ["Recai"], droppedName: "David", teamLabel: "Kırmızı", squad: null, lang: "tr" });
    expect(text.split("\n")[0]).toBe("⬆️ *Recai* yedekten kadroya geçti, *Kırmızı* takımında *David* yerine oynuyor 🙌");
    expect(text).toContain("takımları yeniden kur");
  });

  it("never offers a race", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = buildBenchMovedUpLine({ names: ["A"], droppedName: null, teamLabel: null, squad: { confirmed: 14, maxPlayers: 14 }, lang });
      expect(text).not.toMatch(/first to|claim|ilk sahiplenen/i);
    }
  });
});

describe("the DM to the player who moved up", () => {
  it("EN: he is in, and OUT passes the place on", () => {
    expect(buildBenchMovedUpDm({ firstName: "Recai", context: "for Tuesday 7-a-side tonight" })).toBe(
      "👋 Hi Recai, a place opened for Tuesday 7-a-side tonight and you were first on the bench, so you're in now ✅\n\n" +
        "If you can't make it after all, just reply *OUT* here and I'll pass the place to the next player. 🙏",
    );
  });

  it("EN, no name on record", () => {
    expect(buildBenchMovedUpDm({ firstName: "", context: "for Tuesday 7-a-side tonight" })).toMatch(/^👋 Hi, a place opened/);
  });

  it("TR", () => {
    expect(buildBenchMovedUpDm({ firstName: "Recai", context: "bu akşamki Salı 7'li için", lang: "tr" })).toBe(
      "👋 Recai, bir yer açıldı: bu akşamki Salı 7'li için. Yedekte ilk sıradaydın, artık kadrodasın ✅\n\n" +
        "Gelemeyeceksen buraya *YOKUM* yazman yeterli, yeri sıradaki oyuncuya veririm. 🙏",
    );
  });
});

describe("the bench promise says what now happens", () => {
  it("EN: the first on the bench moves up, no tagging, no race", () => {
    for (const text of [
      buildBenchIntroLine(),
      buildSquadCompleteBenchInvite(),
      buildFullSquadBenchInvite({ matchName: "Tuesday 7-a-side", confirmedCount: 14, maxPlayers: 14 }),
    ]) {
      expect(text).toContain("the first on the bench moves up and I message them");
      expect(text).not.toMatch(/tag the bench|first to reply|first to react/i);
    }
  });

  it("TR", () => {
    for (const text of [
      buildBenchIntroLine({ lang: "tr" }),
      buildSquadCompleteBenchInvite({ lang: "tr" }),
      buildFullSquadBenchInvite({ matchName: "Salı 7'li", confirmedCount: 14, maxPlayers: 14, lang: "tr" }),
    ]) {
      expect(text).toContain("yedekteki ilk kişi kadroya geçer ve ona mesaj atarım");
      expect(text).not.toMatch(/etiketlerim|ilk \*VARIM\* yazan/);
    }
  });

  it("an organiser-pick club keeps its own words", () => {
    expect(buildSquadCompleteBenchInvite({ organiser: true })).not.toContain("moves up");
    expect(buildBenchIntroLine({ organiser: true })).not.toContain("moves up");
  });
});
