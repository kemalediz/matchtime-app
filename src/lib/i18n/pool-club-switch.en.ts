/** A club's own player pool switch in English (2026-10-28). See `pool-club-switch.ts`. */
import type { PoolClubSwitchCopy } from "./pool-club-switch";

export const POOL_CLUB_SWITCH_EN: PoolClubSwitchCopy = {
  notice: (club, audience) =>
    [
      `⚽ *The MatchTime player pool is now on for ${club}*`,
      "Short of players? Ask MatchTime for nearby players who have joined the pool.",
      "",
      "*How to ask*",
      audience === "group" ? "Tag @Match Time here, for example:" : "Tag @Match Time in your club's WhatsApp group, for example:",
      "• @Match Time ask the player pool for 2 players for Thursday",
      "• @Match Time find players from partner clubs and the player pool for Thursday",
      `Only the club's organisers can ask. MatchTime then offers the place to nearby pool players by WhatsApp and tells you${audience === "group" ? " here" : ""} when one takes it.`,
      "",
      "Also:",
      "• tick *MatchTime player pool* on a match",
      "• turn on *Ask the player pool automatically* in Admin, then Settings (partner clubs are asked first)",
      "Want your players to know? Use *Tell your players about the player pool* in Settings.",
    ].join("\n"),
  groupAnnouncement: (club) =>
    [
      `⚽ *The MatchTime player pool is now on for ${club}*`,
      "Short of players? The club's organisers can now ask MatchTime for nearby players who have joined the pool.",
      "",
      "*How to ask* (organisers only)",
      "Tag @Match Time here, for example:",
      "• @Match Time ask the player pool for 2 players for Thursday",
      "• @Match Time find players from partner clubs and the player pool for Thursday",
      "MatchTime then offers the place to nearby pool players by WhatsApp and tells the organisers when one takes it.",
      "",
      "Organisers can also tick *MatchTime player pool* on a match, or turn on *Ask the player pool automatically* in Admin, then Settings.",
    ].join("\n"),
  title: "Player pool",
  lead: "When you're short of players, MatchTime can ask nearby players who have joined the MatchTime player pool. When MatchTime asks by itself, your partner clubs are asked first. Nothing is sent until an admin asks, or until you turn on automatic asking below.",
  confirmOff: "Turn the player pool off for your club? Any ask to the pool still open for your matches is closed now.",
  savedOn: "Player pool on.",
  savedOff: (n) => (n === 0 ? "Player pool off." : `Player pool off. ${n} open ask${n === 1 ? "" : "s"} to the pool closed.`),
};
