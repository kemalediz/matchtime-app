/**
 * BRINGING A GUEST BY CONTACT CARD, ENGLISH (2026-11-17). Turkish in
 * `guest-card.tr.ts`, same keys (a missing key is a tsc error). House
 * rules: no em or en dashes, no slashes as separators, "bench" never
 * "waiting list", no time-of-day greetings, never a phone number, never the
 * group's invite link (a guest plays once before he joins the group,
 * Kemal 2026-11-17). Assembled by `src/lib/guest-card/copy.ts`.
 */
export const guestCardEn = {
  // ── The guest's one welcome DM ───────────────────────────────────────
  welcome_head: (p: { first: string | null; organiser: string | null; club: string }) =>
    p.organiser
      ? `Hi${p.first ? ` ${p.first}` : ""} 👋 ${p.organiser} has added you to *${p.club}*'s game.`
      : `Hi${p.first ? ` ${p.first}` : ""} 👋 You've been added to *${p.club}*'s game.`,
  welcome_when: (p: { when: string }) => `📅 ${p.when}`,
  welcome_format: (p: { format: string }) => `⚽ ${p.format}`,
  welcome_venue: (p: { venue: string }) => `📍 ${p.venue}`,
  welcome_map: (p: { url: string }) => `🗺️ ${p.url}`,
  welcome_fee: (p: { amount: string }) => `💷 ${p.amount} a player`,
  welcome_fee_payg: (p: { amount: string }) => `💷 ${p.amount}, pay as you go`,
  welcome_in: "You're in the squad.",
  welcome_bench: "The squad is full, so you're on the bench for now. If a place opens I'll tell you.",
  welcome_bench_pick: "You're on the bench for now. The organisers pick who plays from the bench.",
  welcome_out: "Reply OUT if you can't make it.",
  welcome_ask: "Any question about the game? Just message me here.",

  // ── The one reply to the organiser, where he asked ───────────────────
  /** `day` is the game's short label; `tonight` when it kicks off today. */
  reply_in: (p: { name: string; day: string; tonight: boolean }) => `✅ ${p.name} is in for ${p.tonight ? "tonight" : p.day}`,
  reply_bench: (p: { name: string; day: string; tonight: boolean }) => `✅ ${p.name} is on the bench for ${p.tonight ? "tonight" : p.day}, the squad is full`,
  reply_already_in: (p: { name: string; day: string; tonight: boolean }) => `${p.name} is already in for ${p.tonight ? "tonight" : p.day}`,
  reply_already_bench: (p: { name: string; day: string; tonight: boolean }) => `${p.name} is already on the bench for ${p.tonight ? "tonight" : p.day}`,
  /** Joins a head that ends with a ✅ add ("…, I've sent him the details."). */
  reply_dm_sent_after_add: ", I've sent him the details.",
  reply_dm_sent: "I've sent him the details.",
  reply_dm_had: "He already has the details.",
  reply_not_ours: "That number is already on MatchTime, so it can't be added here.",
  reply_no_number: "I couldn't find a phone number on that contact, so I haven't added anyone.",
  reply_no_name: "What's his name? Tell me and I'll add him, for example *add Sam Jones for tonight*.",
  reply_no_game: "There's no game coming up to add him to.",
  reply_elsewhere: (p: { name: string }) => `${p.name} is already down as a guest for another game, so I haven't added him to this one.`,
  reply_failed: (p: { name: string }) => `I couldn't add ${p.name} just now. Please add him on the match page.`,

  // ── His OUT by DM ────────────────────────────────────────────────────
  out_dm: (p: { club: string; day: string }) => `No problem, I've taken you off *${p.club}*'s game on ${p.day}.`,
  out_notice: (p: { name: string; organiser: string | null; day: string }) =>
    `${p.name}${p.organiser ? ` (${p.organiser}'s guest)` : ""} can't make it on ${p.day} any more. The place is free again.`,
};

export type GuestCardStrings = typeof guestCardEn;
