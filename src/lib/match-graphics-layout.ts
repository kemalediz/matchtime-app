/**
 * LAYOUT FOR THE LIST POSTER AND THE TEAM SHEET (2026-10-14).
 *
 * The two graphics MatchTime drops in a club's admin group for the admins
 * to forward (`match-graphics-render.tsx` draws them, `match-graphics.ts`
 * loads their data). Every decision that depends on the data lives here,
 * pure, so it is tested without a renderer:
 *
 *   - the canvas: 1080 x 1350, a 4:5 portrait. WhatsApp shows a picture
 *     up to roughly that shape whole in the chat; a taller one (9:16,
 *     1080 x 1920) is cropped in the bubble until it is opened, and the
 *     admins forward from the bubble. 4:5 is also Instagram's portrait
 *     size, if a club cross-posts. 1080 wide is what WhatsApp keeps.
 *   - columns and name size by how many names there are (10 to 24 is the
 *     designed range; anything from 0 to 30 still fits);
 *   - where a long name is cut (by grapheme, so an emoji or a Turkish
 *     letter is never split);
 *   - which first names need a last initial to tell two players apart;
 *   - which colour a team's header gets.
 *
 * The sizes assume Barlow Condensed (assets/fonts), whose capitals are
 * about half an em wide. Names are drawn in capitals.
 */
import type { Lang } from "./i18n/lang";
import { normaliseLang } from "./i18n/lang";
import { graphicsCopy } from "./match-graphics-copy";

export const GRAPHIC_WIDTH = 1080;
export const GRAPHIC_HEIGHT = 1350;
export const GRAPHIC_PADDING = 64;
export const CONTENT_WIDTH = GRAPHIC_WIDTH - 2 * GRAPHIC_PADDING;
export const COLUMN_GAP = 32;

/** Height of the poster's names area with no reserves block. */
export const LIST_NAMES_AREA = 860;
/** What a reserves block takes from it. */
export const RESERVES_BLOCK = 140;
export const MAX_RESERVES_SHOWN = 8;
/** Height of the team sheet's names area, under the two team headers. */
export const TEAM_NAMES_AREA = 780;

const MIN_FONT = 24;
const MAX_FONT = 56;
const MAX_ROW = 84;
/** Average capital width in Barlow Condensed ExtraBold, in ems (a little generous). */
const CHAR_EM = 0.5;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface RowSizing {
  rowHeight: number;
  fontSize: number;
  /** The width of the number in front of a name, gap included. */
  numberWidth: number;
  maxChars: number;
}

function sizeRows(rows: number, area: number, columnWidth: number): RowSizing {
  const rowHeight = Math.min(MAX_ROW, Math.floor(area / Math.max(rows, 1)));
  const fontSize = clamp(Math.round(rowHeight * 0.68), MIN_FONT, MAX_FONT);
  const numberWidth = Math.round(fontSize * 1.25) + 14;
  const maxChars = Math.max(4, Math.floor((columnWidth - numberWidth) / (fontSize * CHAR_EM)));
  return { rowHeight, fontSize, numberWidth, maxChars };
}

const columnWidth = (columns: number) => Math.floor((CONTENT_WIDTH - COLUMN_GAP * (columns - 1)) / columns);

export interface ListPosterLayout extends RowSizing {
  columns: 1 | 2;
  /** Names per column: the first column fills top to bottom, then the second. */
  rows: number;
  columnWidth: number;
  namesAreaHeight: number;
  reservesShown: number;
  reservesHidden: number;
}

export function listPosterLayout(args: { count: number; reserves: number }): ListPosterLayout {
  const count = Math.max(0, args.count);
  const columns: 1 | 2 = count <= 9 ? 1 : 2;
  const rows = Math.max(1, Math.ceil(count / columns));
  const namesAreaHeight = LIST_NAMES_AREA - (args.reserves > 0 ? RESERVES_BLOCK : 0);
  const width = columnWidth(columns);
  const reservesShown = Math.min(Math.max(0, args.reserves), MAX_RESERVES_SHOWN);
  return {
    columns,
    rows,
    columnWidth: width,
    namesAreaHeight,
    reservesShown,
    reservesHidden: Math.max(0, args.reserves - reservesShown),
    ...sizeRows(rows, namesAreaHeight, width),
  };
}

export interface TeamSheetLayout extends RowSizing {
  maxPerTeam: number;
  columnWidth: number;
  namesAreaHeight: number;
}

export function teamSheetLayout(args: { maxPerTeam: number }): TeamSheetLayout {
  const maxPerTeam = Math.max(1, args.maxPerTeam);
  const width = columnWidth(2);
  return { maxPerTeam, columnWidth: width, namesAreaHeight: TEAM_NAMES_AREA, ...sizeRows(maxPerTeam, TEAM_NAMES_AREA, width) };
}

/** The club's name across the top: as big as it fits. */
export function clubNameFontSize(name: string): number {
  const len = Math.max(1, graphemes(name.trim()).length);
  return clamp(Math.floor(CONTENT_WIDTH / (len * CHAR_EM)), 44, 104);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/**
 * A name cut to `maxChars` characters as a reader counts them (graphemes),
 * the last one an ellipsis. Whitespace trimmed and squeezed.
 */
export function fitName(name: string, maxChars: number): string {
  const clean = name.replace(/\s+/g, " ").trim();
  const g = graphemes(clean);
  if (g.length <= maxChars) return clean;
  return `${g.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd()}…`;
}

/** Capitals in the club's language: Turkish "i" is "İ", "ı" is "I". */
export function shoutCase(text: string, lang: Lang | string | null | undefined): string {
  return text.toLocaleUpperCase(normaliseLang(lang) === "tr" ? "tr" : "en");
}

/** A stored name that is really a phone number (an unknown player's row). */
function looksLikePhone(name: string): boolean {
  const digits = name.replace(/\D/g, "");
  return digits.length >= 7 && /^[+\d\s().-]+$/.test(name);
}

/**
 * The names on the image: FIRST NAMES ONLY, as the club knows them. Two
 * players with the same first name get their last initial ("Ali K.",
 * "Ali Y."); the same first name and initial, the whole name. A player
 * with no name, or a phone number for one, is "Player" / "Oyuncu": an
 * image never carries a number.
 */
export function displayNames(
  players: Array<{ id: string; name: string | null | undefined }>,
  lang: Lang | string | null | undefined,
): Map<string, string> {
  const fallback = graphicsCopy(lang).player;
  const locale = normaliseLang(lang) === "tr" ? "tr" : "en";
  const parsed = players.map((p) => {
    const full = (p.name ?? "").replace(/\s+/g, " ").trim();
    if (!full || looksLikePhone(full)) return { id: p.id, first: fallback, last: null as string | null, full: fallback };
    const words = full.split(" ");
    return { id: p.id, first: words[0], last: words.length > 1 ? words[words.length - 1] : null, full };
  });

  const byFirst = new Map<string, typeof parsed>();
  for (const p of parsed) {
    const k = p.first.toLocaleLowerCase(locale);
    byFirst.set(k, [...(byFirst.get(k) ?? []), p]);
  }

  const out = new Map<string, string>();
  for (const group of byFirst.values()) {
    if (group.length === 1) {
      out.set(group[0].id, group[0].first);
      continue;
    }
    const withInitial = group.map((p) => ({
      p,
      label: p.last ? `${p.first} ${graphemes(p.last)[0].toLocaleUpperCase(locale)}.` : p.first,
    }));
    for (const { p, label } of withInitial) {
      const clash = p.last && withInitial.some((o) => o.p !== p && o.p.last && o.label.toLocaleLowerCase(locale) === label.toLocaleLowerCase(locale));
      out.set(p.id, clash ? p.full : label);
    }
  }
  return out;
}

export interface TeamColour {
  bg: string;
  fg: string;
}

const DARK = "#0f172a";
const LIGHT = "#ffffff";

const COLOURS: Array<{ words: RegExp; colour: TeamColour }> = [
  { words: /\b(red|kirmizi)\b/, colour: { bg: "#dc2626", fg: LIGHT } },
  { words: /\b(yellow|sari)\b/, colour: { bg: "#facc15", fg: DARK } },
  { words: /\b(blue|navy|mavi|lacivert)\b/, colour: { bg: "#2563eb", fg: LIGHT } },
  { words: /\b(white|beyaz)\b/, colour: { bg: "#f8fafc", fg: DARK } },
  { words: /\b(black|siyah)\b/, colour: { bg: "#111827", fg: LIGHT } },
  { words: /\b(green|yesil)\b/, colour: { bg: "#16a34a", fg: LIGHT } },
  { words: /\b(orange|turuncu)\b/, colour: { bg: "#f97316", fg: DARK } },
];

/** Turkish letters folded to ASCII so one word list covers both languages. */
function fold(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i");
}

/** The header colour for a team: the colour its label names, else red for the first team and yellow for the second. */
export function teamColour(label: string, slot: 0 | 1): TeamColour {
  const f = fold(label);
  for (const c of COLOURS) if (c.words.test(f)) return c.colour;
  return slot === 0 ? COLOURS[0].colour : COLOURS[1].colour;
}
