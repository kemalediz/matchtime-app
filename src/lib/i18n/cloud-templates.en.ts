/**
 * THE OFFICIAL NUMBER'S MESSAGE TEMPLATES, ENGLISH (WhatsApp Cloud API plan
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md 3.9 and 5.6, PR C6). What Meta
 * approves and sends when we write first and his 24 hour window is closed.
 * Inside the window the existing copy goes free form instead (plan 5.4), so
 * each body mirrors the message it stands in for: the pool offer copy
 * (`pool-offer.en.ts`), the pool's pauses (`pool-safety.en.ts`), the
 * friend link (`friend-link.en.ts`), the welcome (`strings.en.ts`), the
 * details question (`pool-details.en.ts`) and joining a club's group
 * (`pool-invite.en.ts`).
 *
 * `{{n}}` are Meta's variables, filled in `src/lib/cloud-api/templates.ts`
 * by the existing copy functions, so each fact still has one copy home.
 * A link is never in a body: it is a URL button, whose fixed base Meta
 * approves and whose end the variable fills.
 *
 * House rules, unit tested (`__tests__/cloud-templates-copy.test.ts`): no
 * em or en dashes, never "bot", no slashes as separators, "bench" never
 * "waiting list", no time-of-day greeting, Turkish never equal to English,
 * and (ours, not Meta's) no body starts or ends with a variable, so every
 * message reads on its own. `mt_code` has no body here: an authentication
 * template's words are Meta's own fixed text.
 */
export const cloudTemplatesEn = {
  bodies: {
    mt_pool_offer:
      "⚽ *{{1}}* needs {{2}} for a {{3}} on *{{4}}*.\n📍 {{5}}\n⏱️ {{6}}\n\nYou get this because you joined the MatchTime player pool. Would you like the place? Tap Answer, or reply here.",
    mt_pool_placed_in: "✅ You're in: *{{1}}*, {{2}}, {{3}}.\nCan't make it after all? Tap below to give the place back.",
    mt_pool_placed_in_fee:
      "✅ You're in: *{{1}}*, {{2}}, {{3}}.\nThe match fee is {{4}}. You'll get a pay link after the game.\nCan't make it after all? Tap below to give the place back.",
    mt_pool_placed_bench:
      "📝 You're on the bench for *{{1}}*, {{2}}, {{3}}. The organisers pick from the bench, and you'll hear if you play.\nCan't make it after all? Tap below to give the place back.",
    mt_pool_placed_bench_fee:
      "📝 You're on the bench for *{{1}}*, {{2}}, {{3}}. The organisers pick from the bench, and you'll hear if you play.\nThe match fee is {{4}}. You'll get a pay link after the game.\nCan't make it after all? Tap below to give the place back.",
    mt_pool_paused: "I've paused game offers because the last {{1}} went unanswered. Want them again? Tap below.",
    mt_pool_paused_no_shows:
      "I've paused game offers because you didn't turn up to {{1}} of your last {{2}} games. You can start them again in {{3}} days, or ask a person to look at it now. Tap below.",
    mt_pool_paused_review: "I've paused game offers while the MatchTime team looks at your profile. You can ask about it by replying here.",
    mt_pool_resumed: "Game offers are on again. Tap below to see your settings.",
    mt_game_plan_changed: "Plans changed for *{{1}}* on {{2}}: they don't need a player for that game any more. Nothing for you to do.",
    mt_taken_out:
      "The organisers of *{{1}}* took you out of the game on {{2}}. You stay in the MatchTime player pool and will keep hearing about new games near you.",
    mt_place_given_back: "You've given your place back for *{{1}}* on {{2}}. You stay in the MatchTime player pool.",
    mt_pool_joined:
      "✅ You're in the MatchTime player pool. When a club near you needs a player at a time you can play, I'll message you here with the game, and you decide. At most {{1}} a week.",
    mt_pool_joined_early:
      "✅ You're on the early sign-up list for the MatchTime player pool. The pool is not open near you yet, so I won't message you about games until it is. Then it's at most {{1}} a week.",
    mt_pool_details_ask:
      "One quick question so I only send you games that suit you: what times can you play on {{1}}, and which formats do you play ({{2}})? Reply here in your own words. No need to reply if any time and any format are fine.",
    mt_club_invite_after_game: "Enjoyed the game with *{{1}}* on {{2}}? If you'd like to join their group for future games, tap below to answer.",
    mt_club_invite_organiser: "From MatchTime: *{{1}}* would like you to join their group for future games. Tap below to answer.",
    mt_club_invite_link: "🎉 Welcome to *{{1}}*. Tap below to join their WhatsApp group.",
    mt_club_invite_closed:
      "Thanks for saying yes. *{{1}}* is not adding new players to their group right now. You can still get games near you through MatchTime.",
  },

  // ── Button labels (Meta: 25 characters at most) ─────────────────────────
  buttons: {
    answer: "Answer",
    settings: "Settings",
    stop_offers: "Stop game offers",
    give_back: "Give the place back",
    invitations: "Answer",
    join_group: "Join the group",
    copy_code: "Copy code",
  },

  // ── Pieces a variable is filled with, where no copy home has them ──────
  parts: {
    /** The offer's places: "1 player", "2 players". */
    places: (n: number) => `${n} ${n === 1 ? "player" : "players"}`,
    /** The game's length, first on the offer's details line: "60 mins". */
    length: (mins: number) => `${mins} mins`,
  },
};

export type CloudTemplateStrings = typeof cloudTemplatesEn;
