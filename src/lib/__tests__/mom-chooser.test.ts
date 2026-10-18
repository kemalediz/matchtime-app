/**
 * WHO CHOOSES MAN OF THE MATCH (2026-10-18): the setting, the words that
 * change with it, and the facts the shared score extractor reports. Pure:
 * no database, no model.
 */
import { describe, expect, it } from "vitest";
import { normaliseMomChooser, organisersPickMom } from "../mom-chooser";
import { buildMomAnnouncement, buildMomPickedAnnouncement } from "../mom-announcement";
import { buildRatingDm, buildRatingReminderDm } from "../dm-copy";
import { buildAskScoreHqPost } from "../scheduler-copy";
import { organisersContext } from "../admin-group-context";
import { parseFacts, factsSchemaFor } from "../pipeline/extractors";
import { resolveMomRef } from "../mom-pick";
import { formatRatingProgressReply } from "../rating-progress-answer";

describe("the setting", () => {
  it('reads "players" for anything it does not know: today\'s behaviour', () => {
    expect(normaliseMomChooser(undefined)).toBe("players");
    expect(normaliseMomChooser("x")).toBe("players");
    expect(normaliseMomChooser("organisers")).toBe("organisers");
    expect(organisersPickMom(null)).toBe(false);
    expect(organisersPickMom({ momChosenBy: "players" })).toBe(false);
    expect(organisersPickMom({ momChosenBy: "organisers" })).toBe(true);
  });
});

describe("the words", () => {
  it("the organisers' pick is announced with the voted post's header and trophy line, and no vote count", () => {
    const picked = buildMomPickedAnnouncement({ mvpLabel: "Man of the Match", activityName: "FNF", name: "Naim" });
    expect(picked).toBe("🏆 *Man of the Match: FNF*\n\nCongrats *Naim* 🎉\n\nYour trophy awaits next match.");
    expect(picked).not.toMatch(/vote/i);
    expect(buildMomPickedAnnouncement({ mvpLabel: "Man of the Match", activityName: "FNF", name: "Naim", lang: "tr" })).toBe(
      "🏆 *Man of the Match, FNF*\n\nTebrikler *Naim* 🎉\n\nKupa gelecek maçta sahibini bekliyor.",
    );
    // The voted one is unchanged.
    expect(buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "FNF", tally: [{ name: "Naim", votes: 3 }] })).toContain("(3/3 votes)");
  });

  it("the rating DMs ask for ratings only when the organisers pick, and are unchanged otherwise", () => {
    const base = { activityName: "FNF", dateLabel: "Fri 16 Oct", mvpLabel: "Man of the Match", rateUrl: "R", statsUrl: "S" };
    expect(buildRatingDm(base)).toContain("Rate your teammates and pick Man of the Match.");
    expect(buildRatingDm({ ...base, momVote: false })).toContain("Rate your teammates. Takes ~1 minute.");
    expect(buildRatingDm({ ...base, momVote: false })).not.toContain("pick Man of the Match");
    expect(buildRatingDm({ ...base, momVote: false, lang: "tr" })).toContain("Takım arkadaşlarına puan ver. Yaklaşık 1 dakika sürer.");
    const r = { dayNum: 1, playerName: "Naim Khan", activityName: "FNF", mvpLabel: "Man of the Match", url: "U" };
    expect(buildRatingReminderDm(r)).toContain("pick Man of the Match");
    expect(buildRatingReminderDm({ ...r, momVote: false })).not.toContain("Man of the Match");
    expect(buildRatingReminderDm({ ...r, momVote: false, lang: "tr" })).not.toContain("Man of the Match");
  });

  it('"who hasn\'t rated?" reports no Man of the Match vote when the organisers pick', () => {
    const p = { ok: true, matchName: "FNF", matchWhen: "Fri 16 Oct", confirmed: 10, ratedCount: 4, momCount: 3, notRated: ["Ali"], ratedNoMom: ["Can"] };
    const voted = formatRatingProgressReply(p);
    const picked = formatRatingProgressReply({ ...p, momCount: 0, ratedNoMom: [], momVote: false });
    expect(picked.split("\n")).toHaveLength(voted.split("\n").length - 2);
    expect(picked).toContain("Ali");
    expect(picked).not.toContain("Can");
  });

  it("the HQ score ask asks for Man of the Match too, only when the organisers pick", () => {
    expect(buildAskScoreHqPost({ activityName: "FNF" })).toBe("🏁 *FNF*: what was the final score, and which team won? Reply here and I'll record it.");
    expect(buildAskScoreHqPost({ activityName: "FNF", momLabel: "Man of the Match" })).toBe(
      "🏁 *FNF*: what was the final score, which team won, and who was Man of the Match? Reply here and I'll record it.",
    );
    expect(buildAskScoreHqPost({ activityName: "FNF", momLabel: "Man of the Match", lang: "tr" })).toBe(
      "🏁 *FNF*: maç kaç kaç bitti, hangi takım kazandı ve Man of the Match kim? Buraya yazın, kaydedeyim.",
    );
  });

  it("the router is told Man of the Match is waiting, with the score or after it", () => {
    const base = { pending: [], quoted: null, quotedIsMatchTime: false, recent: [] };
    expect(organisersContext({ ...base, score: { kind: "result", day: "Fri 16 Oct", labels: ["Red", "Yellow"] } })).toEqual([
      "WAITING: the final score of Fri 16 Oct's match, Red against Yellow.",
    ]);
    expect(organisersContext({ ...base, score: { kind: "result", day: "Fri 16 Oct", labels: ["Red", "Yellow"], mom: true } })).toEqual([
      "WAITING: the final score of Fri 16 Oct's match, Red against Yellow, and its Man of the Match.",
    ]);
    expect(organisersContext({ ...base, score: { kind: "mom", day: "Fri 16 Oct" } })).toEqual([
      "WAITING: the rest of Fri 16 Oct's result: who was Man of the Match.",
    ]);
  });
});

describe("the shared score extractor reports the name, and decides nothing", () => {
  const wire = { hasScore: true, first: 7, second: 4, firstTeam: "", secondTeam: "", winner: "Yellow", loser: "", correction: false, swapped: false, otherGame: false };

  it("momRef is in the schema, verbatim, and empty means none", () => {
    const schema = factsSchemaFor("score") as { required: string[]; properties: Record<string, { type: string }> };
    expect(schema.required).toContain("momRef");
    expect(schema.properties.momRef).toEqual({ type: "string" });
    expect(parseFacts("score", JSON.stringify({ ...wire, momRef: "Naim" }), "wa-1").facts).toMatchObject({ kind: "score", first: 7, second: 4, winner: "Yellow", momRef: "Naim" });
    expect(parseFacts("score", JSON.stringify({ ...wire, momRef: "" }), "wa-1").facts).not.toHaveProperty("momRef");
    expect(parseFacts("score", JSON.stringify({ ...wire, hasScore: false, winner: "", momRef: "Naim" }), "wa-1").facts).toEqual({
      kind: "score",
      first: null,
      second: null,
      momRef: "Naim",
    });
  });
});

describe("the name is resolved against the match's players", () => {
  const players = [
    { userId: "u-naim", name: "Naim Khan", isAdmin: false, hasPhone: true },
    { userId: "u-a1", name: "Ali Can", isAdmin: false, hasPhone: true },
    { userId: "u-a2", name: "Ali Veli", isAdmin: false, hasPhone: true },
  ];
  it("one player, two players, nobody", () => {
    expect(resolveMomRef("Naim", players)).toEqual({ kind: "resolved", userId: "u-naim", name: "Naim Khan" });
    expect(resolveMomRef("@Naim Khan", players)).toEqual({ kind: "resolved", userId: "u-naim", name: "Naim Khan" });
    expect(resolveMomRef("Ali", players)).toEqual({ kind: "ambiguous", ref: "Ali", names: ["Ali Can", "Ali Veli"] });
    expect(resolveMomRef("Zed", players)).toEqual({ kind: "not-in-match", ref: "Zed" });
    expect(resolveMomRef("everyone", players).kind).toBe("not-in-match");
  });
});
