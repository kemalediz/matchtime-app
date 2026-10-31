/**
 * THE FRIEND LINK'S WORDS, ENGLISH (2026-10-31; plan
 * MDs/friend-link-plan-2026-10-31.md section 4). Turkish in
 * `friend-link.tr.ts`, same keys (a missing key is a tsc error). House
 * rules: no em or en dashes, no slashes as separators, "bench" never
 * "waiting list", no time-of-day greetings. Assembled into whole messages
 * by `src/lib/friend-link/copy.ts`.
 */
export const friendLinkEn = {
  // ── DM to the member who said his friend is coming (club bot) ────────
  member_one: (p: { friend: string | null; club: string; day: string; venue: string | null }) =>
    `Here's the link for ${p.friend ?? "your friend"} to join *${p.club}* on ${p.day}${p.venue ? ` at ${p.venue}` : ""}. Please forward it to ${p.friend ? "him" : "them"}.`,
  member_many: (p: { club: string; day: string; venue: string | null }) =>
    `Here are the links for your friends to join *${p.club}* on ${p.day}${p.venue ? ` at ${p.venue}` : ""}. Please forward each one to the friend it is for. Each friend needs his own link.`,
  member_how: "Your friend can only join this game by opening the link, filling in his details and sending the WhatsApp code it gives him. Each link works for one person, until kick-off.",
  member_cap: (p: { club: string; day: string }) =>
    `You already have links for *${p.club}* on ${p.day} that nobody has used yet, so here they are again:`,
  member_link_line: (p: { n: number; friend: string | null; link: string }) => `${p.n}. ${p.friend ?? "Friend"}: ${p.link}`,
  member_no_phone: (p: { member: string }) =>
    `${p.member}, I couldn't DM you the link for your friend. Message me privately once and tag me here again.`,

  // ── The /play page's match card ──────────────────────────────────────
  page_invited: (p: { member: string }) => `${p.member} invited you to play`,
  page_fee: (p: { amount: string }) => `Fee: ${p.amount}`,
  page_fee_payg: (p: { amount: string }) => `Fee: ${p.amount}, pay as you go`,
  page_free: "Free",
  page_explain: "Fill in your details, then send the WhatsApp code to take your place. This link works until kick-off.",
  page_used: "This link has already been used.",
  page_started: "This game has already started, so the link no longer works.",
  page_called_off: "This game was called off.",
  page_invalid: "This link isn't one we recognise.",
  page_pool_hint: "You can still join the MatchTime player pool to hear about games near you.",
  page_pool_cta: "Join the player pool",

  // ── DM to the friend after his code (platform channel) ───────────────
  booked_in: (p: { club: string; day: string; venue: string | null; member: string }) =>
    `You're in for *${p.club}* on ${p.day}${p.venue ? ` at ${p.venue}` : ""}. ${p.member} brought you in.`,
  booked_bench: (p: { club: string; day: string; venue: string | null; member: string }) =>
    `You're on the bench for *${p.club}* on ${p.day}${p.venue ? ` at ${p.venue}` : ""}. ${p.member} brought you in. The squad is full; if a place opens I'll tell you.`,
  booked_bench_pick: (p: { club: string; day: string; venue: string | null; member: string }) =>
    `You're on the bench for *${p.club}* on ${p.day}${p.venue ? ` at ${p.venue}` : ""}. ${p.member} brought you in. The organisers pick who plays from the bench.`,
  booked_fee: (p: { amount: string }) => `Fee: ${p.amount}, asked of you after the game.`,
  booked_fee_payg: (p: { amount: string }) => `Fee: ${p.amount} as a pay as you go player, asked of you after the game.`,
  booked_pool: "You're now in the MatchTime player pool too, so you'll hear about other games near you.",
  not_booked_pool: "You're in the MatchTime player pool now, so you'll hear about games near you.",
  not_used: "The place on that link was already taken, so you're not booked into that game.",
  not_started: "That game has already started, so you're not booked into it.",
  not_called_off: "That game was called off.",
  not_already: "You're already on the list for that game.",
  not_issuer: "That link is for a friend of yours. To play yourself, say IN in the club's group.",
  not_other: "You're not booked into that game.",
  footer: (p: { link: string }) => `Your settings: ${p.link}`,

  // ── Players' group, once he is booked ────────────────────────────────
  group_in: (p: { name: string; member: string; day: string }) => `🙋 ${p.name} (${p.member}'s friend) is in for ${p.day}.`,
  group_bench: (p: { name: string; member: string; day: string }) => `🙋 ${p.name} (${p.member}'s friend) is on the bench for ${p.day}.`,
  group_bench_pick: (p: { name: string; member: string; day: string }) =>
    `🙋 ${p.name} (${p.member}'s friend) is on the bench for ${p.day}. The organisers pick who plays from the bench. Organisers, to put ${p.name} in, tag me and say so, for example *@Match Time put ${p.name} in*`,

  // ── DM to the friend when an organiser takes him off (platform) ──────
  removed: (p: { club: string; day: string }) =>
    `The organisers of *${p.club}* took you out of the game on ${p.day}. You stay in the MatchTime player pool and will keep hearing about new games near you.`,
};

export type FriendLinkStrings = typeof friendLinkEn;
