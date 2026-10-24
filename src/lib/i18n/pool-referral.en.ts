/** Referral badges and "Brought by" in English (growth slice G4). See `pool-referral.ts`. */
import type { PoolReferralCopy } from "./pool-referral";

const bold = (names: string[]): string => {
  const b = names.map((n) => `*${n}*`);
  return b.length <= 1 ? (b[0] ?? "") : `${b.slice(0, -1).join(", ")} and ${b[b.length - 1]}`;
};

export const POOL_REFERRAL_EN: PoolReferralCopy = {
  postLine: ({ key, emoji, label, names, friends }) => {
    const who = bold(names);
    const many = names.length > 1;
    switch (key) {
      case "recruiter":
        return `${emoji} *${label}*: ${who} ${many ? "each brought" : "brought"} a new player to the game 🙌`;
      case "scout":
        return `${emoji} *${label}*: ${who} ${many ? "have each" : "has"} now brought ${friends} players to the game 👏`;
      case "talent-spotter":
        return `${emoji} *${label}*: ${who} ${many ? "have each" : "has"} now brought ${friends} players to the game, what a talent spotter! 🌟`;
    }
  },
  statsTitle: "Bringing players to the game",
  statsCount: (n) => `Players brought to the game: ${n}`,
  statsHowItCounts: "A friend who signs up with your link counts once he has played his first game.",
  statsPrivate: "You keep these private, so your club's group is not told.",
  badgeHint: (n) => (n === 1 ? "Brought 1 player to the game" : `Brought ${n} players to the game`),
  broughtBy: (name) => `Brought by ${name}`,
};
