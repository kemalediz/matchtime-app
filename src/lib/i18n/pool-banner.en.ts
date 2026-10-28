/** The player pool banner in English. See `pool-banner.ts`. */
import type { PoolBannerCopy } from "./pool-banner";

export const POOL_BANNER_EN: PoolBannerCopy = {
  region: "MatchTime player pool",
  join: {
    text: "Want more games? Join the MatchTime player pool.",
    button: "Join the pool",
    info: {
      title: "The MatchTime player pool",
      lines: [
        "When a team near you is a player short, MatchTime sends you a WhatsApp message with the game.",
        "You decide each time, and say yes only to the games you want.",
        "You can stop any time from your profile.",
      ],
    },
  },
  share: {
    text: "Know someone who wants a game? Share your link.",
    button: "Share",
    info: {
      title: "Your own link",
      lines: [
        "Send your own link to a friend who wants a game.",
        "When they sign up through it, MatchTime messages them on WhatsApp when a team near them is a player short.",
        "Your number is never in the link or the message.",
      ],
    },
  },
  notInterested: "Not interested",
  adminLine: "Tell your players about it",
};
