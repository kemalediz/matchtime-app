/**
 * The words the venue box's suggestion list needs, as plain strings
 * (2026-10-13). A server page renders them once per language and hands
 * them to the client form, so the box needs no string table of its own
 * (the club setup form ships none to the browser on purpose).
 */
import { VENUE_SUGGEST_MAX } from "./venue-suggest-rules";

export interface VenueSuggestLabels {
  /** The list's accessible name. */
  list: string;
  /** Google's required attribution, shown at the foot of the list. */
  powered: string;
  /** What a screen reader is told when the list opens: index = count - 1. */
  counts: string[];
  /** Under the box: the list is a helper, typed text is always fine. */
  hint: string;
  /** Under the box: what is typed is sent to Google. */
  privacy: string;
}

export function venueSuggestLabels(s: {
  venue_suggest_list_label: string;
  venue_suggest_powered: string;
  venue_suggest_count: (p: { count: number }) => string;
  venue_suggest_hint: string;
  venue_suggest_privacy: string;
}): VenueSuggestLabels {
  return {
    list: s.venue_suggest_list_label,
    powered: s.venue_suggest_powered,
    counts: Array.from({ length: VENUE_SUGGEST_MAX }, (_, i) => s.venue_suggest_count({ count: i + 1 })),
    hint: s.venue_suggest_hint,
    privacy: s.venue_suggest_privacy,
  };
}
