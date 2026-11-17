/**
 * THE ADMIN EXTRACTOR'S PROMPT AFTER THE OPEN SQUAD REWRITE (review of
 * #623, item 4). Not the model's behaviour (that is the paid check), but
 * what the prompt must say so one game's words can never flip a club
 * setting:
 *   - one rule, stated once, before the actions: one game never changes a
 *     club setting;
 *   - `open_squad` defined once, as a standing, club-wide change;
 *   - one-game wording ("no limit tonight", "anyone can play this week")
 *     shown as "other", and numbers ("max 14 again", "set the minimum to
 *     10") as player_numbers;
 *   - "back to full teams" kept apart from "put the limit back";
 *   - every action the schema allows is defined, and the parse keeps
 *     `openSquadOff` only on open_squad.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, parseFacts } from "../extractors";

const P = EXTRACTOR_PROMPTS.admin;
const count = (needle: string) => P.split(needle).length - 1;

describe("the admin prompt", () => {
  it("states the one-game rule once, before the actions", () => {
    expect(count("ONE GAME, OR THE CLUB FROM NOW ON.")).toBe(1);
    expect(P.indexOf("ONE GAME, OR THE CLUB FROM NOW ON.")).toBeLessThan(P.indexOf("THE ACTION, exactly one."));
  });

  it("defines open_squad once, as a standing change for the whole club", () => {
    expect(count('  "open_squad" ')).toBe(1);
    expect(P).toContain('"open_squad" the squad limit itself, for the whole club from now on');
  });

  it("shows one game's words as other, and numbers as player_numbers", () => {
    expect(P).toContain('"@Match Time no limit tonight, anyone can come" / "@Match Time bu akşam sınır yok, isteyen gelsin" -> other');
    expect(P).toContain('"@Match Time anyone can play this week" / "@Match Time bu hafta herkes oynayabilir" -> other');
    expect(P).toContain('"@Match Time max 14 again" / "@Match Time yine en fazla 14 kişi" -> player_numbers, maxPlayers 14');
    expect(P).toContain('"@Match Time set the minimum to 10" / "@Match Time en az 10 kişi olsun" -> player_numbers, minPlayers 10');
  });

  it("keeps \"back to full teams\" (the fewest) apart from putting the limit back", () => {
    expect(P).toContain('"@Match Time back to full teams" / "@Match Time yine tam takım" -> player_numbers, fullTeams true');
    expect(P).toContain("This is about the fewest, never about the squad limit.");
    expect(P).toContain('"@Match Time put the limit and the bench back" / "@Match Time kadro sınırını ve yedekleri geri getir" -> open_squad, openSquadOff true');
  });

  it("defines every action the schema allows, each once", () => {
    for (const a of ["recruit", "cancel_match", "restore_match", "switch_format", "move_game", "fee_waiver", "season_break", "set_venue", "quiet_hours", "player_numbers", "open_squad", "retry_ask", "bulk_payment", "reminder", "stats_blast", "other"]) {
      expect(count(`  "${a}" `), a).toBe(1);
    }
  });

  it("the parse keeps openSquadOff on open_squad only", () => {
    const base = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", remindAt: "", note: "", lookbackMatches: 0, playersFrom: [], clubRef: "", venueName: "", venueChoice: 0, breakMonths: [], playMonths: [], quietOff: false, quietFrom: "", quietTo: "", minPlayers: 0, maxPlayers: 0, fullTeams: false, size: 0, aSide: false, game: 0, newDay: "", newTime: "", everyWeek: false, toMatchTime: true };
    expect(parseFacts("admin", JSON.stringify({ ...base, action: "open_squad", openSquadOff: true }), "m1").facts).toMatchObject({ kind: "admin", action: "open_squad", openSquadOff: true });
    expect(parseFacts("admin", JSON.stringify({ ...base, action: "player_numbers", maxPlayers: 14, openSquadOff: true }), "m2").facts).not.toHaveProperty("openSquadOff");
  });
});
