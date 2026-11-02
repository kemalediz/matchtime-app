/**
 * THE PARTNER POOL INVITE, ENGLISH (2026-11-02). The one DM a partner
 * club's player gets after playing for another club, and the words of his
 * join page that the /play copy (`pool-play.en.ts`) does not already have.
 *
 * Kept out of the flat `strings.*.ts` tables, as the other pool copy is:
 * typed, a missing Turkish key is a tsc error, and the house rules are unit
 * tested (`__tests__/pool-partner-invite-copy.test.ts`). The DM names the
 * club he played for, never a person or a number, and says joining is his
 * choice.
 */
export const poolPartnerInviteEn = {
  /** The DM, in his own club's language, once ever. */
  dm: (p: { club: string; link: string }) =>
    `Thanks for playing for *${p.club}*. Want to hear about games near you when your own club isn't playing? If you'd like to, join the MatchTime player pool here: ${p.link}`,

  // ── The join page ─────────────────────────────────────────────────────
  page_lead: "Thanks for playing as a partner guest. Join the pool and MatchTime can tell you when a club near you is a player short at a time you can play. You decide each time.",
  page_optional: "It's up to you: you can still play for partner clubs without joining.",
  page_you: (p: { name: string; tail: string }) => `Joining as ${p.name}, on your WhatsApp number ending ${p.tail}. No code needed: this link came to that number.`,
  page_you_no_name: (p: { tail: string }) => `Joining on your WhatsApp number ending ${p.tail}. No code needed: this link came to that number.`,
  done_heading: "You're in the player pool",
  done_body: "MatchTime will message you on WhatsApp when a game near you needs a player. You can pause or stop it at any time from your MatchTime profile.",
  member_heading: "You're already in the player pool",
  member_body: "Nothing more to do here. You can change your details from your MatchTime profile.",
  stopped_heading: "Start game messages again?",
  stopped_body: "You stopped pool messages before. Tick the box to start them again with the details you saved.",
  restarted_heading: "Game messages are back on",
  expired_heading: "This link has expired",
  expired_body: "You can still join the player pool at any time on the sign-up page.",
  invalid_heading: "This link doesn't work",
  invalid_body: "It may have been copied wrongly. You can join the player pool on the sign-up page.",
  signup_link: "Go to the sign-up page",
};

export type PoolPartnerInviteStrings = typeof poolPartnerInviteEn;
