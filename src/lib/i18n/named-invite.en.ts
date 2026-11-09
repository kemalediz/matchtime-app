/** DMing the people tagged in a message, in English. See `named-invite.ts`. */
import type { NamedInviteCopy } from "./named-invite";

export const NAMED_INVITE_EN: NamedInviteCopy = {
  sent: (p) => `✅ Done. I've sent the invite for *${p.matchName}* (${p.when}) to ${p.names}.`,
  alreadyHad: (p) => `${p.names} already had the invite.`,
  answered: (p) => `${p.names} already answered for this game.`,
  optedOut: (p) => `${p.names} ${p.count === 1 ? "doesn't" : "don't"} get invites by message, so I left them out.`,
  overCap: (p) => `I message at most ${p.cap} people at a time, so I left out ${p.names}. Ask me again for them.`,
  unknown: (p) => `I can't message numbers I don't know yet, so I didn't message ${p.names}.`,
  more: (p) =>
    p.alone ? (p.count === 1 ? "one person" : `${p.count} people`) : p.count === 1 ? "one more person" : `${p.count} more people`,
  nobodyTagged: "I couldn't see anyone tagged in that message, so I haven't messaged anyone.",
  noMatch: "There's no game coming up to invite them to, so I haven't messaged anyone.",
  full: (p) => `*${p.matchName}* has no places open, so I haven't messaged anyone.`,
  notHere: (p) => `${p.names} ${p.count === 1 ? "isn't" : "aren't"} in the club any more, so I left them out.`,
  unidentified: (p) => `I couldn't tell who ${p.count} of the people tagged ${p.count === 1 ? "is" : "are"}, so I didn't message them.`,
  from: (p) =>
    p.senderName ? `📨 From ${p.senderName}'s message:` : p.from === "quoted" ? "📨 From the message you replied to:" : "📨 From the message above:",
  failed: "Something went wrong, so I haven't messaged anyone. Please try again in a minute.",
};
