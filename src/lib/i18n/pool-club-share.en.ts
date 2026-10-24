/** A club's share post in English (growth slice G3). See `pool-club-share.ts`. */
import type { PoolClubShareCopy } from "./pool-club-share";

export const POOL_CLUB_SHARE_EN: PoolClubShareCopy = {
  post: (url) =>
    [
      "⚽ *The MatchTime player pool*",
      "Players in the pool get a WhatsApp message when a team near them is a player short, and they decide each time.",
      "",
      "Want more games? Turn on *Play elsewhere too* on your MatchTime profile. You then get your own link to share with friends.",
      "",
      `Know someone who wants a game? They can sign up here: ${url}`,
    ].join("\n"),
  title: "Tell your players about the player pool",
  lead: "MatchTime can post this once in your players' group, inviting your players to join the pool and bring friends. It names nobody, and it can only be sent once.",
  previewLabel: "The post",
  send: "Send to the players' group",
  sending: "Sending...",
  queued: "Sent. It will be in your players' group in a minute or two.",
  held: (when) => `Sent. It goes out on ${when}, when your quiet hours end.`,
  sentOn: (date) => `You sent this to your players' group on ${date}.`,
  noGroup: "Connect your players' WhatsApp group to MatchTime first, then you can send this.",
  failed: "Could not send it. Please try again.",
};
