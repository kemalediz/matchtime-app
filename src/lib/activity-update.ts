/**
 * WHAT AN EDIT OF A WEEKLY GAME MAY WRITE (review fix 7 of PR #238,
 * 2026-10-12). Pure: from whatever the browser sent to the Prisma `data`
 * for `Activity`, or a refusal in words.
 *
 * `updateActivity` used to hand its whole argument to Prisma. The
 * TypeScript type named nine fields, but a server action is called over
 * the network with whatever the caller sends, so any column could be set
 * by adding a key: the club the activity belongs to, its id, its fee
 * split. Now a field is written only when it is NAMED here and its value
 * passes the same checks creating an activity runs (`activitySchema`).
 * Everything else is dropped, silently, as if it had not been sent.
 *
 * A field that is absent, or present with the value `undefined`, is not
 * touched. That matters most for the fee (`feePerPlayer`): the edit form
 * sends it only when the organiser changed it, so a fee stored some other
 * way (more decimals than the form shows, or above the form's limit) is
 * never rewritten, or made to block the save, by an edit of the venue.
 */
import { parseActivityFee } from "./activity-fee";
import { CLEARED_VENUE_LINK, normaliseVenueText } from "./venue-location-rules";

export interface ActivityUpdateData {
  name?: string;
  sportId?: string;
  dayOfWeek?: number;
  time?: string;
  venue?: string;
  deadlineHours?: number;
  ratingWindowHours?: number;
  matchDurationMins?: number;
  isActive?: boolean;
  feePerPlayer?: number | null;
}

export type ActivityUpdateResult = { ok: true; data: ActivityUpdateData } | { ok: false; error: string };

/**
 * ONE MINIMUM FOR A VENUE, everywhere a weekly game is created or its
 * venue changed: the sign-up form (`validateWeeklyGame`,
 * club-connect-rules.ts), the create form (`activitySchema`,
 * validations.ts), the web setup (actions/onboarding.ts) and the edit
 * below. Sign-up once took one character and the edit wanted two, so a
 * game created with "X" could never be saved again, whatever was edited.
 */
export const VENUE_MIN_LENGTH = 2;
export const VENUE_TOO_SHORT = "Venue must be at least 2 characters";

export const FEE_INVALID = "Enter a fee like 6 or 6.50, at most £100.";
export const FEE_SPLIT = "This game splits the pitch cost, so it has no fixed fee per player.";

const text = (min: number) => (v: unknown): v is string => typeof v === "string" && v.trim().length >= min;
const whole = (min: number, max: number) => (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Each field `updateActivity` may write: its check, and what to say when it fails. */
const FIELDS: Array<[keyof ActivityUpdateData, (v: unknown) => boolean, string]> = [
  ["name", text(2), "Name must be at least 2 characters"],
  ["sportId", text(1), "Pick a sport"],
  ["dayOfWeek", whole(0, 6), "Day must be a day of the week"],
  ["time", isTime, "Time must be HH:mm format"],
  ["venue", text(VENUE_MIN_LENGTH), VENUE_TOO_SHORT],
  ["deadlineHours", whole(1, 48), "Deadline must be 1 to 48 hours before"],
  ["matchDurationMins", whole(20, 180), "Match duration must be 20 to 180 minutes"],
  ["ratingWindowHours", whole(1, 168), "Rating window must be 1 to 168 hours"],
  ["isActive", (v) => typeof v === "boolean", "Active must be on or off"],
];

export function activityUpdateData(input: unknown, current: { feeSplitTotal: boolean; venue?: string | null }): ActivityUpdateResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Nothing to update" };
  const sent = input as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const [key, valid, error] of FIELDS) {
    const value = sent[key];
    if (value === undefined) continue;
    // THE VENUE IS CHECKED ONLY WHEN IT IS BEING CHANGED. The edit form
    // sends every field back, so the stored venue arrives with an edit of
    // the time. A venue stored before the minimum applied (one character,
    // from an older sign-up) must not refuse that edit: sent back as it
    // is, it is not checked. (It is still written, the same words it
    // already holds, exactly as before this rule.)
    const storedVenue =
      key === "venue" && typeof value === "string" && typeof current.venue === "string" && value.trim() === current.venue.trim();
    if (!storedVenue && !valid(value)) return { ok: false, error };
    data[key] = value;
  }
  // The fee: never written as it arrived, and never touched unless it was sent.
  if (sent.feePerPlayer !== undefined) {
    const fee = parseActivityFee(sent.feePerPlayer);
    if (!fee.ok) return { ok: false, error: FEE_INVALID };
    if (fee.fee !== null && current.feeSplitTotal) return { ok: false, error: FEE_SPLIT };
    data.feePerPlayer = fee.fee;
  }
  return { ok: true, data: data as ActivityUpdateData };
}

/**
 * VENUE LOCATION (2026-10-12; review of PR #241, fix 1). `venue` is a
 * named field above; the venue-location columns (`venueId`,
 * `venueConfidence`, `venueMatchSource`, `venueLookupStatus`,
 * `venueResolvedAt`, `venueConfirmedAt`, `venueConfirmedById`) are NOT,
 * so a client can never set one: a place is linked only by the lookup
 * code (src/lib/venue-location.ts).
 *
 * The one thing an edit does to them is this reset. When the venue's
 * words change, every one of those columns goes to null in the SAME
 * write as the new text, so a place found for the old words never stays
 * attached to the new ones. A change of case, spacing or punctuation
 * only is the same venue and resets nothing. Null: nothing to reset.
 *
 * The values are constants (all null). Nothing from the request reaches
 * these columns, here or anywhere.
 */
export function activityVenueReset(data: { venue?: unknown }, current: { venue: string }): typeof CLEARED_VENUE_LINK | null {
  if (typeof data.venue !== "string") return null;
  return normaliseVenueText(data.venue) === normaliseVenueText(current.venue) ? null : CLEARED_VENUE_LINK;
}
