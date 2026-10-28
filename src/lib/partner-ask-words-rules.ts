/**
 * ORGANISERS ASKING PARTNER CLUBS IN THEIR OWN WORDS, THE PURE RULES
 * (slice S6, 2026-10-21). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md,
 * section 5 (S6), with Kemal's extension of 2026-10-21: a club can have
 * several partners, and a request that names no club asks EVERY active
 * partner at once.
 *
 *   resolvePartnerRef      which partners a request means: the club the
 *                          admin extractor reported (`clubRef`, as written)
 *                          looked up against the club's ACTIVE partners,
 *                          the way a name is looked up against the roster
 *   partnerNameScore       how well a name as written fits a partner's name
 *   composePartnerAskReply the ONE reply that says what happened with each
 *                          partner asked (`requestPartnerAsk`'s results)
 *
 * Nothing here reads the organiser's message. The model reports the club's
 * name as written, or nothing; the lookup compares it with the names the
 * database holds. Pure: no database, no model.
 */
import type { PartnerAskWhen } from "./club-partnership-rules";
import { PAUSED_REFUSALS, type AskRefusal } from "./partner-ask-rules";
import { joinChoice, joinList } from "./i18n/text";
import { t } from "./i18n/t";

/** One active partnership the asking club may ask through. */
export interface PartnerChoice {
  partnershipId: string;
  partnerOrgId: string;
  name: string;
}

export type PartnerRefResolution =
  | { kind: "ask"; partners: PartnerChoice[] }
  | { kind: "no-partner" }
  | { kind: "asking-off" }
  | { kind: "no-match"; ref: string; partners: PartnerChoice[] }
  | { kind: "ambiguous"; ref: string; candidates: PartnerChoice[] };

/** Lower case, no accents (Turkish dotless i folded too), no case ending
 *  after an apostrophe ("Sutton'a" is "sutton"), split into words. */
function words(s: string): string[] {
  return s
    .replace(/['’`][\p{L}]*/gu, " ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A word as written against a word of the partner's name. A word under
 *  three letters ("FC", "MT") only counts when it is the whole word; a
 *  longer one may be the start of the name's word ("Sut") or the name's
 *  word with an ending stuck on ("Suttona"). */
function wordFits(written: string, name: string): boolean {
  if (written === name) return true;
  if (written.length < 3 || name.length < 3) return false;
  return name.startsWith(written) || (name.length >= 4 && written.startsWith(name));
}

/** How many words of the name as written fit a word of the partner's name. */
export function partnerNameScore(written: string, partnerName: string): number {
  const nameWords = words(partnerName);
  let score = 0;
  for (const w of words(written)) if (nameWords.some((n) => wordFits(w, n))) score++;
  return score;
}

/**
 * Which partners a request means. In order: no partner at all; asking
 * switched Off; no club named (every active partner, one or many); a
 * named club (the single best fit, never two at once).
 */
export function resolvePartnerRef(i: {
  clubRef: string | null | undefined;
  partners: PartnerChoice[];
  askWhen: PartnerAskWhen | null;
}): PartnerRefResolution {
  if (i.partners.length === 0) return { kind: "no-partner" };
  if (!i.askWhen || i.askWhen === "off") return { kind: "asking-off" };
  const ref = (i.clubRef ?? "").trim();
  if (!ref) return { kind: "ask", partners: i.partners };
  const scored = i.partners.map((p) => ({ p, score: partnerNameScore(ref, p.name) }));
  const best = Math.max(...scored.map((s) => s.score));
  if (best <= 0) return { kind: "no-match", ref, partners: i.partners };
  const top = scored.filter((s) => s.score === best).map((s) => s.p);
  if (top.length > 1) return { kind: "ambiguous", ref, candidates: top };
  return { kind: "ask", partners: top };
}

/** What `requestPartnerAsk` said for one partner. */
export type PartnerAskOutcome = "posted" | "awaiting" | AskRefusal | "not-found";

const UNREACHABLE: ReadonlySet<string> = new Set([
  "partner-muted",
  "partner-dormant",
  "partner-not-approved",
  "partner-paused",
  "partner-setting-up",
  "partner-no-group",
  "partner-not-postable",
]);

/** The ask already open to a partner for this game (an `already-open`
 *  refusal): when it was made, as a day label, and whether it still waits
 *  for the partner's organisers. Null fields: not known. */
export interface OpenPartnerAsk {
  askedOn: string | null;
  awaiting: boolean;
}

/** What a reply needs besides the results: the asking club's cut-off, the
 *  game's day label, and the link to its Partner clubs settings card. */
export interface PartnerReplyContext {
  cutoffHours: number;
  /** The asking club's bench rule: first come (the default) or organiser
   *  pick, which decides where a volunteer who says IN goes. */
  firstCome?: boolean;
  day?: string | null;
  settingsLink?: string;
}

/** A refusal for ONE partner, as a whole sentence: what happened, why, and
 *  what to do next (the chat's wording; a WhatsApp reply never says
 *  "reload the page"). */
function refusalSentence(lang: string | null, partner: string, r: AskRefusal | "not-found", ctx: PartnerReplyContext, open?: OpenPartnerAsk | null): string {
  const s = t(lang);
  const link = ctx.settingsLink ?? "";
  if (r === "too-late") return s.xaskw_refused_too_late({ partner, hours: ctx.cutoffHours, link });
  if (r === "daily-cap") return s.xaskw_refused_daily_cap({ partner });
  if (r === "already-open")
    return s.xaskw_refused_already_open({ partner, askedOn: open?.askedOn ?? null, day: ctx.day ?? null, awaiting: open?.awaiting === true });
  if (r === "no-places") return s.xaskw_refused_no_places({ partner });
  if (r === "asking-off") return s.xaskw_off({ link });
  if (PAUSED_REFUSALS.has(r)) return s.xaskw_refused_paused({ partner });
  if (UNREACHABLE.has(r)) return s.xaskw_refused_unreachable({ partner });
  return s.xaskw_refused_generic({ partner });
}

/** A refusal as a partner's line in a several-partner reply. */
function refusalLine(lang: string | null, partner: string, r: AskRefusal | "not-found", cutoffHours: number, open?: OpenPartnerAsk | null): string {
  const s = t(lang);
  if (r === "too-late") return s.xaskw_line_too_late({ partner, hours: cutoffHours });
  if (r === "daily-cap") return s.xaskw_line_daily_cap({ partner });
  if (r === "already-open") return s.xaskw_line_already_open({ partner, askedOn: open?.askedOn ?? null, awaiting: open?.awaiting === true });
  if (r === "no-places") return s.xaskw_line_no_places({ partner });
  if (r === "asking-off") return s.xaskw_line_off({ partner });
  if (PAUSED_REFUSALS.has(r)) return s.xaskw_line_paused({ partner });
  if (UNREACHABLE.has(r)) return s.xaskw_line_unreachable({ partner });
  return s.xaskw_line_generic({ partner });
}

const asked = (r: PartnerAskOutcome) => r === "posted" || r === "awaiting";

/**
 * The ONE reply for a request that asked one or several partners: what
 * happened with each (posted, waiting for their organisers' OK, or not
 * asked and why), and, when any was asked, where the volunteers go.
 */
export function composePartnerAskReply(
  lang: string | null,
  results: Array<{ partnerName: string; result: PartnerAskOutcome; open?: OpenPartnerAsk | null }>,
  /** `places`: how many players were asked for (P4: a words ask asks for
   *  every open place, and says how many). Absent: no number line. */
  opts: PartnerReplyContext & { places?: number },
): string {
  const s = t(lang);
  const firstCome = opts.firstCome !== false;
  const placesLine = opts.places && opts.places > 0 ? [s.xaskw_places_line({ places: opts.places })] : [];
  if (results.length === 1) {
    const { partnerName: partner, result } = results[0];
    if (result === "posted") return [s.xaskw_posted_one({ partner, firstCome }), ...placesLine].join("\n");
    if (result === "awaiting") return [s.xaskw_awaiting_one({ partner, firstCome }), ...placesLine].join("\n");
    return refusalSentence(lang, partner, result, opts, results[0].open);
  }
  const any = results.some((r) => asked(r.result));
  const lines = results.map(({ partnerName: partner, result, open }) =>
    result === "posted"
      ? s.xaskw_line_posted({ partner })
      : result === "awaiting"
        ? s.xaskw_line_awaiting({ partner })
        : refusalLine(lang, partner, result, opts.cutoffHours, open),
  );
  // A refusal a setting can lift (the cut-off, asking switched off): the
  // settings card's link, once, after the list.
  const settingsLine =
    opts.settingsLink && results.some((r) => r.result === "too-late" || r.result === "asking-off") ? [s.xaskw_settings_line({ link: opts.settingsLink })] : [];
  return [any ? s.xaskw_header_asked : s.xaskw_header_not_asked, ...lines, ...(any ? [s.xaskw_bench_line({ firstCome }), ...placesLine] : []), ...settingsLine].join("\n");
}

/** The one plain reply when nothing could be asked at all. */
export function resolutionReply(lang: string | null, r: Exclude<PartnerRefResolution, { kind: "ask" }>, settingsLink = ""): string {
  const s = t(lang);
  switch (r.kind) {
    case "no-partner":
      return s.xaskw_no_partner({ link: settingsLink });
    case "asking-off":
      return s.xaskw_off({ link: settingsLink });
    case "no-match":
      return s.xaskw_no_match({ ref: r.ref, partners: joinList(lang, r.partners.map((p) => p.name)) });
    case "ambiguous":
      return s.xaskw_ambiguous({ ref: r.ref, choice: joinChoice(lang, r.candidates.map((p) => p.name)) });
  }
}
