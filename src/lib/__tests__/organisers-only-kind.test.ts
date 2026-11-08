/**
 * The line for someone who is not an organiser and asked MatchTime for
 * something only the organisers may do (2026-11-08, Monday night vets: a
 * player tagged MatchTime "we need 2 players, ask our partner clubs and the
 * player pool" and heard "Only Davide can change that."). The line names
 * what was asked, from what the code already knows (the extractor's action,
 * or the path itself), never from the person's words.
 */
import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";
import { organisersOnlyKindOfAction, type OrganisersOnlyKind } from "../organisers-only-kind";

const en = t("en").hq_only_organisers;
const tr = t("tr").hq_only_organisers;

describe("hq_only_organisers, by kind", () => {
  it.each<[OrganisersOnlyKind, string, string]>([
    ["players", "Only Davide can ask for players.", "Only the club's organisers can ask for players."],
    ["cancel", "Only Davide can cancel the game.", "Only the club's organisers can cancel the game."],
    ["restore", "Only Davide can bring the game back.", "Only the club's organisers can bring the game back."],
    ["teams", "Only Davide can make the teams.", "Only the club's organisers can make the teams."],
    ["score", "Only Davide can change the score.", "Only the club's organisers can change the score."],
    ["settings", "Only Davide can change that.", "Only the club's organisers can change that."],
    ["other", "Only Davide can do that.", "Only the club's organisers can do that."],
  ])("EN %s", (kind, named, unnamed) => {
    expect(en({ names: "Davide", kind })).toBe(named);
    expect(en({ names: "", kind })).toBe(unnamed);
  });

  it.each<[OrganisersOnlyKind, string, string]>([
    ["players", "Yalnızca Davide oyuncu isteyebilir.", "Yalnızca kulübün organizatörleri oyuncu isteyebilir."],
    ["cancel", "Maçı yalnızca Davide iptal edebilir.", "Maçı yalnızca kulübün organizatörleri iptal edebilir."],
    ["restore", "İptali yalnızca Davide geri alabilir.", "İptali yalnızca kulübün organizatörleri geri alabilir."],
    ["teams", "Takımları yalnızca Davide kurabilir.", "Takımları yalnızca kulübün organizatörleri kurabilir."],
    ["score", "Skoru yalnızca Davide değiştirebilir.", "Skoru yalnızca kulübün organizatörleri değiştirebilir."],
    ["settings", "Bunu yalnızca Davide değiştirebilir.", "Bunu yalnızca kulübün organizatörleri değiştirebilir."],
    ["other", "Bunu yalnızca Davide yapabilir.", "Bunu yalnızca kulübün organizatörleri yapabilir."],
  ])("TR %s", (kind, named, unnamed) => {
    expect(tr({ names: "Davide", kind })).toBe(named);
    expect(tr({ names: "", kind })).toBe(unnamed);
  });

  it("no kind: the generic line, never 'change that'", () => {
    expect(en({ names: "Kemal or Hamzah" })).toBe("Only Kemal or Hamzah can do that.");
    expect(tr({ names: "Kemal veya Hamzah" })).toBe("Bunu yalnızca Kemal veya Hamzah yapabilir.");
  });

  it("every kind: no dashes, no slashes, TR differs from EN", () => {
    const kinds: OrganisersOnlyKind[] = ["players", "cancel", "restore", "teams", "score", "settings", "other"];
    for (const kind of kinds) {
      for (const line of [en({ names: "Davide", kind }), en({ names: "", kind }), tr({ names: "Davide", kind }), tr({ names: "", kind })]) {
        expect(line).not.toMatch(/[–—/]/);
      }
      expect(tr({ names: "", kind })).not.toBe(en({ names: "", kind }));
    }
  });
});

describe("organisersOnlyKindOfAction: the extractor's action, never the words", () => {
  it.each<[string | null, OrganisersOnlyKind]>([
    ["recruit", "players"],
    ["retry_ask", "players"],
    ["cancel_match", "cancel"],
    ["restore_match", "restore"],
    ["set_venue", "settings"],
    ["quiet_hours", "settings"],
    ["player_numbers", "settings"],
    ["switch_format", "settings"],
    ["season_break", "settings"],
    ["fee_waiver", "other"],
    ["something_new", "other"],
    [null, "other"],
  ])("%s: %s", (action, kind) => {
    expect(organisersOnlyKindOfAction(action)).toBe(kind);
  });
});
