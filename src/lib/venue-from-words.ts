/**
 * SETTING THE PITCH BY WHATSAPP (2026-10-28, Kemal: every admin feature
 * also works by tagging MatchTime). "@Match Time our pitch is Goals
 * Sutton", "@Match Time sahamız Goals Sutton".
 *
 * The admin extractor reads `set_venue` with the words as written
 * (`venueName`), or a number picked from MatchTime's own list
 * (`venueChoice`). This does what the web's venue box does with them:
 *
 *   1. Google's Places suggestions for the words (`placesAutocomplete`,
 *      the same call `/api/venue/suggest` makes, inside the same hourly
 *      per-person cap, `claimSuggestCall`);
 *   2. which one is meant, by code (`venue-from-words-rules.ts`): one clear
 *      match is set, several are listed by number, none is said;
 *   3. the one meant is set on the club's home venue and the upcoming game
 *      (`setClubVenueToPlace`), from Google's own answer for the place id.
 *
 * The reply names the place with its address so the organiser can see it
 * is right, and links the settings card where it can be changed. When
 * places cannot be looked up (no key, a cap, Google failing) the organiser
 * is sent there instead. Who may do this is the caller's (an owner or
 * admin). Logs carry ids and the outcome, never the words or the place.
 */
import { randomUUID } from "node:crypto";
import { appUrl } from "./app-url";
import { adminVenueCopy } from "./i18n/admin-venue";
import { chooseVenue, type VenueFromWordsOutcome } from "./venue-from-words-rules";
import { suggestLanguage, type VenuePick, type VenueSuggestion } from "./venue-suggest-rules";
import type { AutocompleteOutcome } from "./places";

export type { VenueFromWordsOutcome };

export interface VenueFromWordsResult {
  outcome: VenueFromWordsOutcome;
  replyText: string;
  /** The pitch was set: what waited for it may be tried again. */
  set: boolean;
}

export interface VenueFromWordsDeps {
  placesConfigured: () => boolean;
  claimSuggestCall: (userId: string, now: Date) => Promise<boolean>;
  autocomplete: (req: { input: string; sessionToken: string; languageCode: string }) => Promise<AutocompleteOutcome>;
  setPlace: (a: {
    orgId: string;
    userId: string;
    pick: VenuePick;
    confirmed: boolean;
    now: Date;
  }) => Promise<{ status: "found"; name: string; address: string; activityId: string | null } | { status: "capped" | "unresolved" }>;
}

/** The settings card that holds the club's venue (`settings-anchors.ts`). */
const VENUE_SETTINGS_URL = (): string => appUrl("/admin/settings#club-venue");

async function defaultDeps(): Promise<VenueFromWordsDeps> {
  const [places, cap, location] = await Promise.all([import("./places"), import("./venue-suggest-cap"), import("./venue-location")]);
  return {
    placesConfigured: () => places.placesConfigured(),
    claimSuggestCall: (userId, now) => cap.claimSuggestCall(userId, now),
    autocomplete: (req) => places.placesAutocomplete(req),
    setPlace: (a) => location.setClubVenueToPlace(a.orgId, a.userId, a.pick, { now: a.now, confirmed: a.confirmed }),
  };
}

const optionLine = (x: VenueSuggestion): string => (x.secondary ? `${x.primary}, ${x.secondary}` : x.primary);

export async function setVenueFromWords(args: {
  orgId: string;
  userId: string;
  words: string | null;
  /** A number picked from MatchTime's list, 1 first; null for none. */
  choice: number | null;
  lang: string | null;
  now: Date;
  deps?: VenueFromWordsDeps;
}): Promise<VenueFromWordsResult> {
  const c = adminVenueCopy(args.lang);
  const url = VENUE_SETTINGS_URL();
  const words = (args.words ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!words) return { outcome: "venue-no-name", replyText: c.noName, set: false };
  const unavailable = (why: string): VenueFromWordsResult => {
    console.log(`[venue-words] org=${args.orgId} outcome=unavailable reason=${why}`);
    return { outcome: "venue-unavailable", replyText: c.unavailable({ url }), set: false };
  };

  const deps = args.deps ?? (await defaultDeps());
  if (!deps.placesConfigured()) return unavailable("off");
  if (!(await deps.claimSuggestCall(args.userId, args.now))) return unavailable("suggest-cap");
  const sessionToken = randomUUID();
  const got = await deps.autocomplete({ input: words, sessionToken, languageCode: suggestLanguage(args.lang) });
  if (got.status !== "ok") return unavailable(got.status === "error" ? got.code : got.status);

  const chosen = chooseVenue(words, got.suggestions, args.choice);
  if (chosen.kind === "none") {
    console.log(`[venue-words] org=${args.orgId} outcome=none`);
    return { outcome: "venue-none", replyText: c.none({ words, url }), set: false };
  }
  if (chosen.kind === "several") {
    console.log(`[venue-words] org=${args.orgId} outcome=which count=${chosen.options.length}`);
    return { outcome: "venue-which", replyText: c.which({ words, options: chosen.options.map(optionLine) }), set: false };
  }

  const placed = await deps.setPlace({
    orgId: args.orgId,
    userId: args.userId,
    pick: { placeId: chosen.pick.placeId, sessionToken },
    // Picked by number from MatchTime's list: a pick, as on the web.
    confirmed: args.choice !== null && args.choice >= 1,
    now: args.now,
  });
  if (placed.status !== "found") return unavailable(placed.status);
  console.log(`[venue-words] org=${args.orgId} outcome=set activity=${placed.activityId ?? "none"}`);
  return {
    outcome: "venue-set",
    replyText: c.set({ name: placed.name || chosen.pick.primary, address: placed.address, url }),
    set: true,
  };
}
