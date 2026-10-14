/**
 * A CLUB'S OWN GRAPHICS TEMPLATE: ITS LAYOUT AND ITS RULES (2026-10-14).
 *
 * Some clubs already post a designed team sheet every week (FNF's night
 * stadium board, two columns of nine). For such a club MatchTime draws its
 * list poster and team sheet ON the club's own blank background, so what
 * the admins forward looks like what they have always posted. The
 * background and this layout are stored on the club
 * (`ClubGraphicsTemplate`, `club-graphics-template.ts`), never in git: they
 * carry the club's branding. A club without one gets the default MatchTime
 * design (`match-graphics-render.tsx`).
 *
 * THE LAYOUT, in the background's own pixels:
 *   - `rows`: the centre of the lettering (cap height) on each row, top to
 *     bottom, the same in both columns;
 *   - `columns`: where a name starts and how wide it may be, the centre of
 *     the row's shirt icon (the list poster prints the number on it) and
 *     the colour that number is printed in;
 *   - `date`, `time`: where the day and kickoff go, beside the template's
 *     own calendar and clock icons;
 *   - `squadHeader`: the band the list poster lays over the two team
 *     headers, a gradient from one team colour to the other with the
 *     squad word across it, with `keep` boxes (the shirts) put back on top;
 *   - `reserves`: the one line under the board for the bench.
 *
 * THE RULES (`templateChoice`): the team sheet uses the template only when
 * both teams have exactly as many players as it has rows; the list poster
 * when the list fits its two columns. Anything else is drawn in the
 * default design, and only the route's log says so.
 *
 * Pure: no clock, no database, no renderer. Widths come in as a `measure`
 * function so the fitting is tested without a font.
 */
import { z } from "zod";
import { tr as trLocale } from "date-fns/locale";
import { formatLondon } from "./london-time";
import { normaliseLang, type Lang } from "./i18n/lang";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const px = z.number().finite().min(0).max(4000);
const size = z.number().finite().min(6).max(200);
const box = z.object({ x: px, y: px, width: px, height: px });
/** A line of text beside an icon; `maxWidth` is the room before the board's edge (it shrinks to fit). */
const textSpot = z.object({ x: px, centreY: px, fontSize: size, colour: hex, maxWidth: px });
const column = z.object({ nameX: px, maxWidth: px, iconCentreX: px, badgeColour: hex });

const layoutSchema = z
  .object({
    version: z.literal(1),
    width: z.number().int().min(100).max(4000),
    height: z.number().int().min(100).max(4000),
    rows: z.array(px).min(1).max(20),
    capHeight: size,
    name: z.object({ colour: hex, maxFontSize: size, minFontSize: size }),
    columns: z.tuple([column, column]),
    date: textSpot,
    time: textSpot,
    squadHeader: z.object({
      panel: box,
      from: hex,
      to: hex,
      titleColour: hex,
      titleFontSize: size,
      title: z.string().trim().min(1).max(24).optional(),
      keep: z.array(box).max(4),
    }),
    reserves: z.object({ centreX: px, centreY: px, fontSize: size, colour: hex, maxWidth: px }),
  })
  .refine((l) => l.name.minFontSize <= l.name.maxFontSize);

export type ClubGraphicsLayout = z.infer<typeof layoutSchema>;

/** The stored layout, checked, or null when it is not one this code can draw. */
export function parseClubGraphicsLayout(raw: unknown): ClubGraphicsLayout | null {
  const r = layoutSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ── Template or default ─────────────────────────────────────────────────

export type TemplateChoice = { design: "template" } | { design: "default"; reason: "team-size" | "list-too-long" };

type ChoiceInput =
  | { kind: "teams"; teams: readonly [{ names: readonly string[] }, { names: readonly string[] }] }
  | { kind: "list"; players: readonly string[] };

export function templateChoice(data: ChoiceInput, layout: ClubGraphicsLayout): TemplateChoice {
  const rows = layout.rows.length;
  if (data.kind === "teams") {
    return data.teams.every((t) => t.names.length === rows) ? { design: "template" } : { design: "default", reason: "team-size" };
  }
  return data.players.length <= rows * layout.columns.length ? { design: "template" } : { design: "default", reason: "list-too-long" };
}

export type GraphicDesign = { design: "template" } | { design: "default"; reason: "no-template" | "team-size" | "list-too-long" };

/** What the graphics route draws: the club's template when it has one that can hold this graphic, else the default design. */
export function graphicDesign(data: ChoiceInput, layout: ClubGraphicsLayout | null): GraphicDesign {
  if (!layout) return { design: "default", reason: "no-template" };
  return templateChoice(data, layout);
}

// ── Fitting a name ──────────────────────────────────────────────────────

export type Measure = (text: string, fontSize: number) => number;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment);

/**
 * The name at the template's size if it fits its box; else as small as it
 * needs, down to `minFontSize`; else cut (whole characters, an ellipsis
 * last) at that size.
 */
export function fitTemplateName(
  name: string,
  opts: { maxWidth: number; maxFontSize: number; minFontSize: number; measure: Measure },
): { text: string; fontSize: number } {
  const text = name.replace(/\s+/g, " ").trim();
  const { maxWidth, maxFontSize, minFontSize, measure } = opts;
  const full = measure(text, maxFontSize);
  if (full <= maxWidth) return { text, fontSize: maxFontSize };
  const scaled = Math.floor((maxFontSize * maxWidth) / full);
  if (scaled >= minFontSize) return { text, fontSize: scaled };
  const g = graphemes(text);
  for (let n = g.length - 1; n >= 1; n--) {
    const cut = `${g.slice(0, n).join("").trimEnd()}…`;
    if (measure(cut, minFontSize) <= maxWidth) return { text: cut, fontSize: minFontSize };
  }
  return { text: "…", fontSize: minFontSize };
}

// ── Date, time and reserves in the template's style ────────────────────

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "16th October" / "16 Ekim", London. */
export function templateDateLabel(lang: Lang | string | null | undefined, d: Date): string {
  if (normaliseLang(lang) === "tr") return formatLondon(d, "d MMMM", trLocale);
  return `${ordinal(Number(formatLondon(d, "d")))} ${formatLondon(d, "MMMM")}`;
}

/** "8:30pm", "9pm" / "20:30", London. */
export function templateTimeLabel(lang: Lang | string | null | undefined, d: Date): string {
  if (normaliseLang(lang) === "tr") return formatLondon(d, "HH:mm");
  const minutes = formatLondon(d, "mm");
  return formatLondon(d, minutes === "00" ? "haaa" : "h:mmaaa");
}

/**
 * "RESERVES: SAM, JOE", as many as fit in `maxWidth`, then "+3 more".
 * Null when there is no one on the bench.
 */
export function reservesLine(
  names: readonly string[],
  opts: { label: string; more: (n: number) => string; maxWidth: number; fontSize: number; measure: Measure },
): string | null {
  if (names.length === 0) return null;
  const { label, more, maxWidth, fontSize, measure } = opts;
  for (let shown = names.length; shown >= 1; shown--) {
    const hidden = names.length - shown;
    const line = `${label}: ${names.slice(0, shown).join(", ")}${hidden > 0 ? ` ${more(hidden)}` : ""}`;
    if (measure(line, fontSize) <= maxWidth) return line;
  }
  return `${label}: ${more(names.length)}`;
}
