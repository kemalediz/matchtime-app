/**
 * Preset sports — copied into each new Organisation's sport library when
 * created, or picked explicitly by the admin when creating an Activity.
 *
 * Admins can edit any field after seeding (positions list, team labels, MVP
 * label, composition, etc). These are just the starting points.
 *
 * `balancingStrategy` values:
 *   - "position-aware": snake draft + hill-climb that minimises rating diff
 *     AND positional imbalance against `positionComposition` (football-style).
 *   - "rating-only":    snake draft on rating only; positions ignored during
 *     balancing (3v3 basketball, cricket-for-now, any roster with no fixed
 *     role per slot).
 *   - "role-quota" (not implemented yet): drafts against role quotas
 *     `{Bowler:{min:4,max:6},Batter:{min:4}}`. Deferred until cricket orgs
 *     ask for it.
 */
export interface SportPreset {
  key: string;
  name: string;
  playersPerTeam: number;
  positions: string[];
  teamLabels: [string, string];
  mvpLabel: string;
  balancingStrategy: "position-aware" | "rating-only";
  positionComposition?: Record<string, number>;
}

export const SPORT_PRESETS: readonly SportPreset[] = [
  {
    key: "football-7aside",
    name: "Football 7-a-side",
    playersPerTeam: 7,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 2, MID: 2, FWD: 2 },
  },
  {
    // Same positions, labels and MoM label as the 7-a-side preset, with
    // the extra player in defence: 1 GK plus a 3-2-2 outfield.
    key: "football-8aside",
    name: "Football 8-a-side",
    playersPerTeam: 8,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 3, MID: 2, FWD: 2 },
  },
  {
    // Same positions, labels and MoM label as the 7- and 8-a-side
    // presets: 1 GK plus a 3-3-2 outfield.
    key: "football-9aside",
    name: "Football 9-a-side",
    playersPerTeam: 9,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 3, MID: 3, FWD: 2 },
  },
  {
    key: "football-11aside",
    name: "Football 11-a-side",
    playersPerTeam: 11,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 4, MID: 4, FWD: 2 },
  },
  {
    key: "football-5aside",
    name: "Football 5-a-side",
    playersPerTeam: 5,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 1, MID: 2, FWD: 1 },
  },
  {
    key: "futsal",
    name: "Futsal",
    playersPerTeam: 5,
    positions: ["GK", "DEF", "Pivot", "Winger"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Player of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GK: 1, DEF: 1, Pivot: 1, Winger: 2 },
  },
  {
    key: "basketball-5v5",
    name: "Basketball 5-on-5",
    playersPerTeam: 5,
    positions: ["PG", "SG", "SF", "PF", "C"],
    teamLabels: ["Home", "Away"],
    mvpLabel: "MVP",
    balancingStrategy: "position-aware",
    positionComposition: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1 },
  },
  {
    key: "basketball-3v3",
    name: "Basketball 3-on-3",
    playersPerTeam: 3,
    positions: ["Guard", "Forward", "Center"],
    teamLabels: ["Shirts", "Skins"],
    mvpLabel: "MVP",
    balancingStrategy: "rating-only",
  },
  {
    key: "netball",
    name: "Netball",
    playersPerTeam: 7,
    positions: ["GS", "GA", "WA", "C", "WD", "GD", "GK"],
    teamLabels: ["Red", "Blue"],
    mvpLabel: "Player of the Match",
    balancingStrategy: "position-aware",
    positionComposition: { GS: 1, GA: 1, WA: 1, C: 1, WD: 1, GD: 1, GK: 1 },
  },
  {
    key: "volleyball",
    name: "Volleyball",
    playersPerTeam: 6,
    positions: ["Setter", "OH", "MB", "Opposite", "Libero"],
    teamLabels: ["Home", "Away"],
    mvpLabel: "MVP",
    balancingStrategy: "position-aware",
    positionComposition: { Setter: 1, OH: 2, MB: 2, Opposite: 1 },
  },
  {
    key: "cricket",
    name: "Cricket",
    playersPerTeam: 11,
    positions: ["Batter", "Bowler", "All-rounder", "Wicket-keeper"],
    teamLabels: ["Home", "Away"],
    mvpLabel: "Player of the Match",
    balancingStrategy: "rating-only",
  },
];

export function findPreset(key: string): SportPreset | undefined {
  return SPORT_PRESETS.find((p) => p.key === key);
}
