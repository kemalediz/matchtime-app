/** The pool's sharing in English (growth slice G1). See `pool-share.ts`. */
import type { PoolShareCopy } from "./pool-share";

export const POOL_SHARE_EN: PoolShareCopy = {
  heading: "Bring a friend",
  intro: "Know someone who wants a game? Send them your own link. When they sign up through it, we know you brought them, and it counts once they have played.",
  linkLabel: "Your link",
  messageLabel: "The message WhatsApp opens with",
  copyLink: "Copy link",
  copied: "Copied",
  copyFailed: "Could not copy. Press and hold the link to copy it.",
  shareWhatsApp: "Share on WhatsApp",
  recognitionOn: (name) => `People who open your link see that ${name} invited them. The privacy switch on your pool page turns this off. Your number is never in the link or the message.`,
  recognitionOff: "People who open your link do not see your name. Your number is never in the link or the message.",
  message: (url) => `I get local games through MatchTime, and it does player ratings and Man of the Match too. Sign up here and they'll message you on WhatsApp when a team near you needs a player: ${url}`,
  invitedBy: (name) => `${name} invited you.`,
};
