/**
 * THE OFFICIAL NUMBER'S MESSAGE TEMPLATES, AS CODE (WhatsApp Cloud API plan
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md 3.9, 5.6 and section 6, PR C6).
 * Pure: no database, no network, no clock.
 *
 * One entry per Meta template: its name, category, languages, the
 * platform job purposes it serves, what fills each body variable,
 * its buttons, and an example Meta reviews it with. The words are in
 * `src/lib/i18n/cloud-templates.{en,tr}.ts`; the values come from the
 * copy functions the free form messages already use, so a fact has one
 * copy home whichever way it is sent.
 *
 * ── RULES THE FILL KEEPS (refused, never sent wrong) ───────────────────
 *   Meta refuses an empty variable, or one with a new line, a tab or more
 *   than four spaces in a row. A URL button's base is fixed at approval
 *   and its variable is the end of the link only, so a link of the wrong
 *   kind (another path, another host) is refused here.
 *
 * ── DECIDED ────────────────────────────────────────────────────────────
 *   Codes use Meta's authentication template (`mt_code`, decision 4): its
 *   text is Meta's own, with the security line, a 10 minute expiry and a
 *   copy code button. Pool offers are submitted as utility (decision 1).
 *   A message whose free form copy has an optional sentence (the placed
 *   fee) has a template for each shape, since a variable cannot be empty.
 */
import { dayCommaTimeLabel, dayLabel, longDayTimeLabel } from "../i18n/dates";
import { cloudTemplatesEn, type CloudTemplateStrings } from "../i18n/cloud-templates.en";
import { cloudTemplatesTr } from "../i18n/cloud-templates.tr";
import { normaliseLang, type Lang } from "../i18n/lang";
import { daysInWords, formatsChoice } from "../pool/copy";
import { clubLineOf, feeLineOf, gameOf, offerWhereOf, styleOf, type PoolFee, type PoolOfferFacts } from "../pool/offer-copy";
import type { PlatformDmPurpose } from "../platform-jobs";
import type { CloudTemplateCategory } from "./vocab";

/** Meta's language codes for the languages the product ships. */
export const META_LANG = { en: "en_GB", tr: "tr" } as const satisfies Record<Lang, string>;
export type MetaLang = (typeof META_LANG)[Lang];
const LANGUAGES: readonly MetaLang[] = [META_LANG.en, META_LANG.tr];

/** The app's own links in buttons are fixed to this origin at approval. */
const APP = "https://matchtime.ai";
const OFFER_URL = `${APP}/play/offer/{{1}}`;
const SIGNED_LINK_URL = `${APP}/r/{{1}}`;
const GROUP_URL = "https://chat.whatsapp.com/{{1}}";

/** The code's life, as `phone-signup.ts` drops it after 10 minutes. */
export const CODE_EXPIRY_MINUTES = 10;

type ButtonLabel = keyof CloudTemplateStrings["buttons"];

export type CloudTemplateButton =
  | { kind: "url"; label: ButtonLabel; url: string }
  | { kind: "quick_reply"; label: ButtonLabel }
  | { kind: "copy_code"; label: ButtonLabel };

interface Placed {
  club: string;
  kickoff: Date;
  venueName: string;
  /** `/play/offer/<token>`: where he gives the place back. */
  offerLink: string;
}

/** The facts each template is filled from, by name. */
export interface CloudTemplateFacts {
  mt_code: { code: string };
  mt_pool_offer: { offer: PoolOfferFacts; offerLink: string; manageLink: string };
  mt_pool_placed_in: Placed;
  mt_pool_placed_in_fee: Placed & { fee: string };
  mt_pool_placed_bench: Placed;
  mt_pool_placed_bench_fee: Placed & { fee: string };
  mt_pool_paused: { n: number; manageLink: string };
  mt_pool_paused_no_shows: { n: number; games: number; days: number; manageLink: string };
  mt_pool_paused_review: Record<string, never>;
  mt_pool_resumed: { manageLink: string };
  mt_game_plan_changed: { club: string; kickoff: Date };
  mt_taken_out: { club: string; kickoff: Date };
  mt_place_given_back: { club: string; kickoff: Date; manageLink: string };
  mt_pool_joined: { perWeek: number; manageLink: string };
  mt_pool_joined_early: { perWeek: number; manageLink: string };
  mt_pool_details_ask: { days: readonly number[]; manageLink: string };
  mt_club_invite_after_game: { club: string; kickoff: Date; invitationsLink: string };
  mt_club_invite_organiser: { club: string; invitationsLink: string };
  mt_club_invite_link: { club: string; groupLink: string };
  mt_club_invite_closed: { club: string };
}
export type CloudTemplateName = keyof CloudTemplateFacts;

export interface CloudTemplateDef<N extends CloudTemplateName = CloudTemplateName> {
  name: N;
  category: CloudTemplateCategory;
  /** The platform jobs it stands in for (each a first contact purpose in
   *  `send-channel.ts`, proven by the registry's test). */
  purposes: readonly PlatformDmPurpose[];
  languages: readonly MetaLang[];
  /** What fills each body variable, in order ({{1}} first). */
  vars: readonly string[];
  buttons: readonly CloudTemplateButton[];
  /** The body values, and for each button that takes one (URL, copy code)
   *  in order, its full link or the code. */
  fill: (lang: Lang, f: CloudTemplateFacts[N]) => { body: string[]; links: string[] };
  /** What Meta reviews it with: invented, never a real person. */
  example: CloudTemplateFacts[N];
}

/** What a send carries: the body values in order, and each button's. This
 *  is what a job keeps in `PlatformJob.templateParams`. */
export interface CloudTemplateParams {
  body: string[];
  buttons: Array<{ index: number; text: string }>;
}

export type CloudTemplateFill = { ok: true; params: CloudTemplateParams } | { ok: false; reason: string };

const COPY: Record<Lang, CloudTemplateStrings> = { en: cloudTemplatesEn, tr: cloudTemplatesTr };
const copyOf = (lang: Lang) => COPY[normaliseLang(lang)];

const SETTINGS: CloudTemplateButton = { kind: "url", label: "settings", url: SIGNED_LINK_URL };
const GIVE_BACK: CloudTemplateButton = { kind: "url", label: "give_back", url: OFFER_URL };
const INVITATIONS: CloudTemplateButton = { kind: "url", label: "invitations", url: SIGNED_LINK_URL };

const EXAMPLE_KICKOFF = new Date("2026-11-13T20:00:00Z");
const EXAMPLE_OFFER_LINK = `${APP}/play/offer/Xy12.AbCd34`;
const EXAMPLE_SIGNED_LINK = `${APP}/r/k7Qp2m9`;
const EXAMPLE_PLACED: Placed = { club: "Riverside FC", kickoff: EXAMPLE_KICKOFF, venueName: "Riverside Leisure Centre", offerLink: EXAMPLE_OFFER_LINK };

/** The offer's details line: its length always (so the line is never
 *  empty), then the play style, the club line and the fee when known. */
function offerDetails(lang: Lang, o: PoolOfferFacts): string {
  return [copyOf(lang).parts.length(o.durationMins), styleOf(lang, o.playStyle), clubLineOf(lang, o.members, o.gamesLast8Weeks), feeLineOf(lang, o.fee)]
    .filter((x): x is string => !!x)
    .join(". ");
}

const placedBody = (lang: Lang, p: Placed) => [p.club, longDayTimeLabel(lang, p.kickoff), p.venueName];

const REGISTRY: { [N in CloudTemplateName]: CloudTemplateDef<N> } = {
  mt_code: {
    name: "mt_code",
    category: "AUTHENTICATION",
    purposes: ["otp"],
    languages: LANGUAGES,
    vars: ["the code"],
    buttons: [{ kind: "copy_code", label: "copy_code" }],
    fill: (_lang, f) => ({ body: [f.code], links: [f.code] }),
    example: { code: "482913" },
  },
  mt_pool_offer: {
    name: "mt_pool_offer",
    category: "UTILITY",
    purposes: ["pool-offer"],
    languages: LANGUAGES,
    vars: ["club", "places (parts.places)", "game (gameOf)", "day (longDayTimeLabel)", "where (offerWhereOf)", "length, style, club line, fee (offerDetails)"],
    buttons: [{ kind: "url", label: "answer", url: OFFER_URL }, SETTINGS, { kind: "quick_reply", label: "stop_offers" }],
    fill: (lang, f) => ({
      body: [f.offer.club, copyOf(lang).parts.places(f.offer.places), gameOf(lang, f.offer), longDayTimeLabel(lang, f.offer.kickoff), offerWhereOf(lang, f.offer), offerDetails(lang, f.offer)],
      links: [f.offerLink, f.manageLink],
    }),
    example: {
      offer: {
        club: "Riverside FC",
        places: 2,
        sport: "football",
        format: 7,
        kickoff: EXAMPLE_KICKOFF,
        durationMins: 60,
        venueName: "Riverside Leisure Centre",
        address: "1 River Road, London",
        mapUrl: null,
        distanceMiles: 1.5,
        playStyle: "casual",
        members: 24,
        gamesLast8Weeks: 8,
        fee: { kind: "amount", amount: "£6" },
      },
      offerLink: EXAMPLE_OFFER_LINK,
      manageLink: EXAMPLE_SIGNED_LINK,
    },
  },
  mt_pool_placed_in: {
    name: "mt_pool_placed_in",
    category: "UTILITY",
    purposes: ["pool-placed"],
    languages: LANGUAGES,
    vars: ["club", "day (longDayTimeLabel)", "venue"],
    buttons: [GIVE_BACK],
    fill: (lang, f) => ({ body: placedBody(lang, f), links: [f.offerLink] }),
    example: EXAMPLE_PLACED,
  },
  mt_pool_placed_in_fee: {
    name: "mt_pool_placed_in_fee",
    category: "UTILITY",
    purposes: ["pool-placed"],
    languages: LANGUAGES,
    vars: ["club", "day (longDayTimeLabel)", "venue", "fee amount"],
    buttons: [GIVE_BACK],
    fill: (lang, f) => ({ body: [...placedBody(lang, f), f.fee], links: [f.offerLink] }),
    example: { ...EXAMPLE_PLACED, fee: "£6" },
  },
  mt_pool_placed_bench: {
    name: "mt_pool_placed_bench",
    category: "UTILITY",
    purposes: ["pool-placed"],
    languages: LANGUAGES,
    vars: ["club", "day (longDayTimeLabel)", "venue"],
    buttons: [GIVE_BACK],
    fill: (lang, f) => ({ body: placedBody(lang, f), links: [f.offerLink] }),
    example: EXAMPLE_PLACED,
  },
  mt_pool_placed_bench_fee: {
    name: "mt_pool_placed_bench_fee",
    category: "UTILITY",
    purposes: ["pool-placed"],
    languages: LANGUAGES,
    vars: ["club", "day (longDayTimeLabel)", "venue", "fee amount"],
    buttons: [GIVE_BACK],
    fill: (lang, f) => ({ body: [...placedBody(lang, f), f.fee], links: [f.offerLink] }),
    example: { ...EXAMPLE_PLACED, fee: "£6" },
  },
  mt_pool_paused: {
    name: "mt_pool_paused",
    category: "UTILITY",
    purposes: ["pool-paused"],
    languages: LANGUAGES,
    vars: ["offers unanswered in a row"],
    buttons: [SETTINGS],
    fill: (_lang, f) => ({ body: [String(f.n)], links: [f.manageLink] }),
    example: { n: 3, manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_pool_paused_no_shows: {
    name: "mt_pool_paused_no_shows",
    category: "UTILITY",
    purposes: ["pool-paused"],
    languages: LANGUAGES,
    vars: ["games missed", "games counted", "days until he can start again"],
    buttons: [SETTINGS],
    fill: (_lang, f) => ({ body: [String(f.n), String(f.games), String(f.days)], links: [f.manageLink] }),
    example: { n: 2, games: 5, days: 14, manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_pool_paused_review: {
    name: "mt_pool_paused_review",
    category: "UTILITY",
    purposes: ["pool-paused"],
    languages: LANGUAGES,
    vars: [],
    buttons: [],
    fill: () => ({ body: [], links: [] }),
    example: {},
  },
  mt_pool_resumed: {
    name: "mt_pool_resumed",
    category: "UTILITY",
    purposes: ["pool-paused"],
    languages: LANGUAGES,
    vars: [],
    buttons: [SETTINGS],
    fill: (_lang, f) => ({ body: [], links: [f.manageLink] }),
    example: { manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_game_plan_changed: {
    name: "mt_game_plan_changed",
    category: "UTILITY",
    purposes: ["pool-removed"],
    languages: LANGUAGES,
    vars: ["club", "day (dayCommaTimeLabel)"],
    buttons: [],
    fill: (lang, f) => ({ body: [f.club, dayCommaTimeLabel(lang, f.kickoff)], links: [] }),
    example: { club: "Riverside FC", kickoff: EXAMPLE_KICKOFF },
  },
  mt_taken_out: {
    name: "mt_taken_out",
    category: "UTILITY",
    purposes: ["friend-removed"],
    languages: LANGUAGES,
    vars: ["club", "day (dayCommaTimeLabel)"],
    buttons: [],
    fill: (lang, f) => ({ body: [f.club, dayCommaTimeLabel(lang, f.kickoff)], links: [] }),
    example: { club: "Riverside FC", kickoff: EXAMPLE_KICKOFF },
  },
  mt_place_given_back: {
    name: "mt_place_given_back",
    category: "UTILITY",
    purposes: ["friend-out"],
    languages: LANGUAGES,
    vars: ["club", "day (dayCommaTimeLabel)"],
    buttons: [SETTINGS],
    fill: (lang, f) => ({ body: [f.club, dayCommaTimeLabel(lang, f.kickoff)], links: [f.manageLink] }),
    example: { club: "Riverside FC", kickoff: EXAMPLE_KICKOFF, manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_pool_joined: {
    name: "mt_pool_joined",
    category: "UTILITY",
    purposes: ["pool-welcome"],
    languages: LANGUAGES,
    vars: ["offers a week at most (POOL_CAPS.perPlayerPerWeek)"],
    buttons: [SETTINGS],
    fill: (_lang, f) => ({ body: [String(f.perWeek)], links: [f.manageLink] }),
    example: { perWeek: 2, manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_pool_joined_early: {
    name: "mt_pool_joined_early",
    category: "UTILITY",
    purposes: ["pool-welcome"],
    languages: LANGUAGES,
    vars: ["offers a week at most (POOL_CAPS.perPlayerPerWeek)"],
    buttons: [SETTINGS],
    fill: (_lang, f) => ({ body: [String(f.perWeek)], links: [f.manageLink] }),
    example: { perWeek: 2, manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_pool_details_ask: {
    name: "mt_pool_details_ask",
    category: "UTILITY",
    purposes: ["pool-details-ask"],
    languages: LANGUAGES,
    vars: ["his days (daysInWords)", "the formats (formatsChoice)"],
    buttons: [SETTINGS],
    fill: (lang, f) => ({ body: [daysInWords(lang, f.days), formatsChoice(lang)], links: [f.manageLink] }),
    example: { days: [2, 6], manageLink: EXAMPLE_SIGNED_LINK },
  },
  mt_club_invite_after_game: {
    name: "mt_club_invite_after_game",
    category: "MARKETING",
    purposes: ["club-invite-ask"],
    languages: LANGUAGES,
    vars: ["club", "day (dayLabel)"],
    buttons: [INVITATIONS],
    fill: (lang, f) => ({ body: [f.club, dayLabel(lang, f.kickoff)], links: [f.invitationsLink] }),
    example: { club: "Riverside FC", kickoff: EXAMPLE_KICKOFF, invitationsLink: EXAMPLE_SIGNED_LINK },
  },
  mt_club_invite_organiser: {
    name: "mt_club_invite_organiser",
    category: "MARKETING",
    purposes: ["club-invite-ask"],
    languages: LANGUAGES,
    vars: ["club"],
    buttons: [INVITATIONS],
    fill: (_lang, f) => ({ body: [f.club], links: [f.invitationsLink] }),
    example: { club: "Riverside FC", invitationsLink: EXAMPLE_SIGNED_LINK },
  },
  mt_club_invite_link: {
    name: "mt_club_invite_link",
    category: "UTILITY",
    purposes: ["club-invite-link"],
    languages: LANGUAGES,
    vars: ["club"],
    buttons: [{ kind: "url", label: "join_group", url: GROUP_URL }],
    fill: (_lang, f) => ({ body: [f.club], links: [f.groupLink] }),
    example: { club: "Riverside FC", groupLink: "https://chat.whatsapp.com/Ab12Cd34Ef56Gh78" },
  },
  mt_club_invite_closed: {
    name: "mt_club_invite_closed",
    category: "UTILITY",
    purposes: ["club-invite-closed"],
    languages: LANGUAGES,
    vars: ["club"],
    buttons: [],
    fill: (_lang, f) => ({ body: [f.club], links: [] }),
    example: { club: "Riverside FC" },
  },
};

export const CLOUD_TEMPLATES: readonly CloudTemplateDef[] = Object.values(REGISTRY) as CloudTemplateDef[];

export function cloudTemplate<N extends CloudTemplateName>(name: N): CloudTemplateDef<N> {
  return REGISTRY[name];
}

/** The body as Meta approves it, `{{n}}` and all; null for an
 *  authentication template, whose words are Meta's own. */
export function templateBody(name: CloudTemplateName, lang: Lang): string | null {
  if (name === "mt_code") return null;
  return copyOf(lang).bodies[name];
}

/** Which placed template: the fee sentence only when there is an amount. */
export function placedTemplateName(p: { bench: boolean; fee: PoolFee }): "mt_pool_placed_in" | "mt_pool_placed_in_fee" | "mt_pool_placed_bench" | "mt_pool_placed_bench_fee" {
  const fee = p.fee?.kind === "amount";
  if (p.bench) return fee ? "mt_pool_placed_bench_fee" : "mt_pool_placed_bench";
  return fee ? "mt_pool_placed_in_fee" : "mt_pool_placed_in";
}

/** Which welcome, for a profile that joined on the web with no message. */
export function joinedTemplateName(earlyList: boolean): "mt_pool_joined" | "mt_pool_joined_early" {
  return earlyList ? "mt_pool_joined_early" : "mt_pool_joined";
}

/** What Meta lets a variable hold: not empty, one line, no long runs of spaces. */
function variableProblem(v: string): string | null {
  if (!v.trim()) return "is empty";
  if (/[\n\t]/.test(v)) return "has a new line or a tab";
  if (/ {5,}/.test(v)) return "has more than four spaces in a row";
  return null;
}

/** The end of `link` that the button's fixed base leaves open, or null when
 *  the link is not that button's kind. The app's own links may come from
 *  another origin (a preview deploy's NEXTAUTH_URL); the path decides. */
function urlSuffix(buttonUrl: string, link: string): string | null {
  const base = new URL(buttonUrl.replace("{{1}}", ""));
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (base.origin !== APP && url.origin !== base.origin) return null;
  if (!url.pathname.startsWith(base.pathname)) return null;
  const rest = url.pathname.slice(base.pathname.length) + url.search;
  return rest && !/[\s/]/.test(rest) ? rest : null;
}

/** Every variable and button value for a send, or why it cannot be sent. */
export function templateParams<N extends CloudTemplateName>(name: N, lang: Lang, facts: CloudTemplateFacts[N]): CloudTemplateFill {
  const def = cloudTemplate(name);
  const { body, links } = def.fill(normaliseLang(lang), facts);
  if (body.length !== def.vars.length) return { ok: false, reason: `${body.length} values for ${def.vars.length} variables` };
  for (const [i, v] of body.entries()) {
    const problem = variableProblem(v);
    if (problem) return { ok: false, reason: `variable ${i + 1} (${def.vars[i]}) ${problem}` };
  }
  const buttons: CloudTemplateParams["buttons"] = [];
  let next = 0;
  for (const [index, b] of def.buttons.entries()) {
    if (b.kind === "quick_reply") continue;
    const value = links[next++] ?? "";
    if (b.kind === "copy_code") {
      if (!/^\d{4,8}$/.test(value)) return { ok: false, reason: "the code is not 4 to 8 digits" };
      buttons.push({ index, text: value });
      continue;
    }
    const suffix = urlSuffix(b.url, value);
    if (!suffix) return { ok: false, reason: `button ${index} (${b.label}): the link is not a ${b.url} link` };
    buttons.push({ index, text: suffix });
  }
  return { ok: true, params: { body, buttons } };
}

/** The message as he would read it, for tests and the sync script's
 *  report; null for an authentication template (Meta's words). */
export function renderTemplatePreview(name: CloudTemplateName, lang: Lang, params: CloudTemplateParams): string | null {
  const body = templateBody(name, lang);
  return body === null ? null : body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params.body[Number(n) - 1] ?? `{{${n}}}`);
}

/** Meta's `template` object for `POST /<PHONE_NUMBER_ID>/messages`
 *  (`type: "template"`). Defined here, not in the client (PR C4), so the
 *  registry owns its own wire shape. */
export interface MetaTemplateMessage {
  name: string;
  language: { code: MetaLang };
  components: Array<
    | { type: "body"; parameters: Array<{ type: "text"; text: string }> }
    | { type: "button"; sub_type: "url"; index: string; parameters: Array<{ type: "text"; text: string }> }
  >;
}

export function templateMessage(name: CloudTemplateName, lang: Lang, params: CloudTemplateParams): MetaTemplateMessage {
  const components: MetaTemplateMessage["components"] = [];
  if (params.body.length) components.push({ type: "body", parameters: params.body.map((text) => ({ type: "text", text })) });
  // A copy code button is sent as a URL button carrying the code (Meta's
  // authentication template send).
  for (const b of params.buttons) components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: b.text }] });
  return { name, language: { code: META_LANG[normaliseLang(lang)] }, components };
}

/** One component of a template as Meta takes it on submission and lists it. */
export type MetaTemplateComponent = { type: string } & Record<string, unknown>;

/** The components to submit to `POST /<WABA_ID>/message_templates`. */
export function metaComponents(name: CloudTemplateName, lang: Lang): MetaTemplateComponent[] {
  const def = cloudTemplate(name);
  const labels = copyOf(lang).buttons;
  if (def.category === "AUTHENTICATION") {
    return [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: CODE_EXPIRY_MINUTES },
      { type: "BUTTONS", buttons: def.buttons.map((b) => ({ type: "OTP", otp_type: "COPY_CODE", text: labels[b.label] })) },
    ];
  }
  const filled = templateParams(name, lang, def.example as never);
  if (!filled.ok) throw new Error(`${name}: its example does not fill: ${filled.reason}`);
  const example = filled.params;
  const body: MetaTemplateComponent = { type: "BODY", text: templateBody(name, lang) };
  if (example.body.length) body.example = { body_text: [example.body] };
  if (def.buttons.length === 0) return [body];
  const buttons = def.buttons.map((b, index) => {
    if (b.kind === "url") return { type: "URL", text: labels[b.label], url: b.url, example: [b.url.replace("{{1}}", example.buttons.find((x) => x.index === index)!.text)] };
    return { type: "QUICK_REPLY", text: labels[b.label] };
  });
  return [body, { type: "BUTTONS", buttons }];
}
