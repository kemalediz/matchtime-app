/**
 * THE LOCAL PLAYER POOL'S VOCABULARY (slice L1, 2026-10-24). PURE.
 *
 * Every enum-in-a-string column the pool's tables carry, with its values,
 * defined ONCE here. The DB CHECKs in prisma/sql/pool-check.sql and the
 * L1 migration are pinned to these lists by
 * `__tests__/schema-sql.test.ts`: add a value here and that test names the
 * CHECK to change.
 *
 * Plan: MDs/local-player-pool-plan-2026-10-23.md, section 7, extended by
 * MDs/local-player-pool-approved-spec-2026-10-24.md.
 */

// ── PoolProfile ────────────────────────────────────────────────────────

/**
 * A pool profile's life:
 *   pending-verify  filled in on /play; nothing is live until the person's
 *                   own WhatsApp message carrying `confirmCode` arrives
 *                   (MatchTime never messages first). No `userId` yet.
 *   active          offers may be sent (subject to every switch and cap).
 *   paused          no offers; `pausedReason` says why.
 *   stopped         the person withdrew consent. No offers until they
 *                   consent again. Deleting a profile removes the row.
 */
export const POOL_PROFILE_STATUSES = ["pending-verify", "active", "paused", "stopped"] as const;
export type PoolProfileStatus = (typeof POOL_PROFILE_STATUSES)[number];

/** Why a profile is paused: by the person, 3 ignored offers in a row, the
 *  no-show rule, reports from clubs, or by the platform owner. */
export const POOL_PAUSE_REASONS = ["self", "ignored", "no-shows", "reports", "admin"] as const;
export type PoolPauseReason = (typeof POOL_PAUSE_REASONS)[number];

/** Where consent was given: the WhatsApp confirm message (its message id is
 *  the evidence), or a signed-in member's own profile page (L3). */
export const POOL_CONSENT_CHANNELS = ["whatsapp", "web"] as const;
export type PoolConsentChannel = (typeof POOL_CONSENT_CHANNELS)[number];

/** How the person came to the pool. `sourceCode` names the campaign or the
 *  referrer's share code. */
export const POOL_PROFILE_SOURCES = ["web", "profile", "referral", "campaign"] as const;
export type PoolProfileSource = (typeof POOL_PROFILE_SOURCES)[number];

/** `PoolAttempt.kind` (slice L2): a WhatsApp confirm code that did not
 *  work, keyed by the sending number; a /play sign-up attempt, keyed by
 *  the requesting address; or a wrong "last 4 digits" on an offer page,
 *  keyed by the offer (L5a). Read only to rate-limit. */
export const POOL_ATTEMPT_KINDS = ["confirm", "signup", "offer-verify"] as const;
export type PoolAttemptKind = (typeof POOL_ATTEMPT_KINDS)[number];
/** A confirm code that did not work: named no sign-up, had expired, or was
 *  sent by a number that already has a profile (never attached). */
export const POOL_CONFIRM_ATTEMPT_RESULTS = ["wrong", "expired", "has-profile"] as const;
export type PoolConfirmAttemptResult = (typeof POOL_CONFIRM_ATTEMPT_RESULTS)[number];
/** A sign-up attempt that got as far as placing the area. */
export const POOL_SIGNUP_ATTEMPT_RESULTS = ["created", "area-not-found", "venues-unknown"] as const;
export type PoolSignupAttemptResult = (typeof POOL_SIGNUP_ATTEMPT_RESULTS)[number];
/** A wrong "last 4 digits" on a pool offer's page (slice L5a, review of
 *  #400 M2), keyed by the offer: five in a day lock the digits for it. */
export const POOL_OFFER_VERIFY_ATTEMPT_RESULTS = ["wrong"] as const;

/** `PoolConsentRecord.action`: an agreement given, or withdrawn (stop, or
 *  delete). Append-only; kept POOL_RETENTION.consentRecordYears. */
export const POOL_CONSENT_ACTIONS = ["consent", "withdraw"] as const;
export type PoolConsentAction = (typeof POOL_CONSENT_ACTIONS)[number];

// ── PoolAsk / PoolOffer ────────────────────────────────────────────────

/** A club's ask to the pool for one match. Created only once an organiser
 *  approved it (decision D-1), so there is no "awaiting" state. */
export const POOL_ASK_STATUSES = ["open", "filled", "closed", "cancelled"] as const;
export type PoolAskStatus = (typeof POOL_ASK_STATUSES)[number];

/** How the ask was approved: the match page, a YES to the short-squad
 *  notice, the club's automatic ask, or an organiser's words in HQ. */
export const POOL_ASK_VIA = ["page", "notice", "auto", "words"] as const;
export type PoolAskVia = (typeof POOL_ASK_VIA)[number];

/**
 * How one offer ended. NULL while it is open.
 *   accepted   he took the place (a GuestPlace row records the game).
 *   declined   he said no.
 *   ignored    no answer by the offer's own expiry. Counts toward the
 *              3-in-a-row pause (`POOL_CAPS.ignoredInARowPause`).
 *   expired    the ask closed first (filled by others, cut-off). Not his
 *              doing, so it never counts as ignored.
 *   filled     he said yes, but the place had just gone.
 *   stopped    he answered "stop": the profile stops too.
 *   cancelled  never reached him (a switch went off, the match was called
 *              off) or was withdrawn before he answered.
 * What happened at the game itself is NOT here: it is `GuestPlace.result`,
 * the one record of a guest's game for partner and pool guests alike.
 */
export const POOL_OFFER_OUTCOMES = ["accepted", "declined", "ignored", "expired", "filled", "stopped", "cancelled"] as const;
export type PoolOfferOutcome = (typeof POOL_OFFER_OUTCOMES)[number];

/** How he answered: the tap link (deterministic) or his own words (L6). */
export const POOL_REPLY_VIA = ["link", "words"] as const;
export type PoolReplyVia = (typeof POOL_REPLY_VIA)[number];

/** Which wave of a round an offer went in (`POOL_ROUND`). */
export const POOL_OFFER_WAVES = [1, 2] as const;

// ── PoolBlock / PoolCampaign ───────────────────────────────────────────

/** Who blocked whom: the club blocked the person, or the person the club. */
export const POOL_BLOCK_BY = ["club", "player"] as const;
export type PoolBlockBy = (typeof POOL_BLOCK_BY)[number];

/** Who reported a problem to the platform owner (slice L7): a club about
 *  a guest, or a player about a club. The same two sides as a block. */
export const POOL_REPORT_BY = POOL_BLOCK_BY;
export type PoolReportBy = PoolBlockBy;

/** The pauses only MatchTime (or a person reviewing them) decides. They
 *  survive a stop (slice L7), and a review can be asked for them. */
export const POOL_MATCHTIME_PAUSE_REASONS = ["no-shows", "reports", "admin"] as const satisfies readonly PoolPauseReason[];

/** A campaign code's channel (G1). */
export const POOL_CAMPAIGN_SOURCES = ["linkedin", "leaflet", "club", "other"] as const;
export type PoolCampaignSource = (typeof POOL_CAMPAIGN_SOURCES)[number];

// ── Guests (club side: partner and pool alike) ─────────────────────────

/** Where a guest came from: the pool, or a partner club's ask. */
export const GUEST_SOURCES = ["pool", "partner"] as const;
export type GuestSource = (typeof GUEST_SOURCES)[number];

/** `Membership.guestVia`: the same two marks, on the guest membership. */
export const MEMBERSHIP_GUEST_VIA = GUEST_SOURCES;

/**
 * One guest's game for a club (`GuestPlace.result`):
 *   booked       on the match, game not played yet.
 *   played       turned up.
 *   no-show      confirmed and did not come (marked by an organiser, L7).
 *   late-cancel  pulled out after the club's cut-off.
 *   withdrawn    pulled out in time.
 */
export const GUEST_RESULTS = ["booked", "played", "no-show", "late-cancel", "withdrawn"] as const;
export type GuestResult = (typeof GUEST_RESULTS)[number];

/** A club invitation (My invitations, Invite to club, joining the group). */
export const CLUB_INVITATION_STATUSES = ["open", "accepted", "declined", "withdrawn"] as const;
export type ClubInvitationStatus = (typeof CLUB_INVITATION_STATUSES)[number];

/** after-game: both sides asked after a game. organiser: the "Invite to
 *  club" button, whose tap is the admins' yes. */
export const CLUB_INVITATION_ORIGINS = ["after-game", "organiser"] as const;
export type ClubInvitationOrigin = (typeof CLUB_INVITATION_ORIGINS)[number];

export const INVITATION_DECLINED_BY = ["club", "player"] as const;
export type InvitationDeclinedBy = (typeof INVITATION_DECLINED_BY)[number];

// ── Organisation ───────────────────────────────────────────────────────

/** The club's own description of its games, shown on an offer. NULL: the
 *  offer simply has no style line. */
export const PLAY_STYLES = ["casual", "competitive", "mixed"] as const;
export type PlayStyle = (typeof PLAY_STYLES)[number];

/** Is `v` one of `values`? A narrowing helper for every list above. */
export function isOneOf<T extends string | number>(values: readonly T[], v: unknown): v is T {
  return (values as readonly unknown[]).includes(v);
}
