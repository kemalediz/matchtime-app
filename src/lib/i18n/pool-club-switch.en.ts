/** A club's own player pool switch in English (2026-10-28). See `pool-club-switch.ts`. */
import type { PoolClubSwitchCopy } from "./pool-club-switch";

export const POOL_CLUB_SWITCH_EN: PoolClubSwitchCopy = {
  notice: (club, audience) =>
    [
      `⚽ *The MatchTime player pool is now on for ${club}*`,
      "When you're short of players, MatchTime can ask nearby players who have joined the pool. Your partner clubs are always asked first.",
      "Nothing is sent by itself. You can:",
      "• tick *MatchTime player pool* on a match to ask for players",
      audience === "group"
        ? '• ask me here, for example "@Match Time we need 2 players for Thursday"'
        : '• ask me in your club\'s WhatsApp group, for example "@Match Time we need 2 players for Thursday"',
      "• turn on *Ask the player pool automatically* in Admin, then Settings",
      "Want your players to know? Use *Tell your players about the player pool* in Settings.",
    ].join("\n"),
  title: "Player pool",
  lead: "When you're short of players, MatchTime can ask nearby players who have joined the MatchTime player pool. Your partner clubs are always asked first. Nothing is sent until an admin asks, or until you turn on automatic asking below.",
  confirmOff: "Turn the player pool off for your club? Any ask to the pool still open for your matches is closed now.",
  savedOn: "Player pool on.",
  savedOff: (n) => (n === 0 ? "Player pool off." : `Player pool off. ${n} open ask${n === 1 ? "" : "s"} to the pool closed.`),
};
