/**
 * THE POSTERS CARD'S PREVIEW (2026-10-14, /admin/settings).
 *
 * The owner sees the club's actual list poster and team sheet for its
 * next match (real first names, day, kickoff and venue), drawn in the
 * chosen design. When there is no next match, too few names on the list
 * (`MIN_REAL_LIST_NAMES`) or no teams yet, the same design is drawn with
 * clearly marked sample names, "Player 1" to "Player 18" ("Oyuncu 1" to
 * "Oyuncu 18"), on the real match's day, time and venue when there is a
 * match, so the owner always sees what the design looks like. A sample
 * never carries a real name: it replaces every name, bench included.
 *
 * `previewGraphicData` is pure; `loadPreviewGraphic` reads the club.
 */
import { db } from "./db";
import { formatLondon, londonWallClockToUtc } from "./london-time";
import { normaliseLang, type Lang } from "./i18n/lang";
import { resolveTeamLabels } from "./team-labels";
import { graphicsCopy, type GraphicKind } from "./match-graphics-copy";
import { loadGraphicData, nextGraphicMatch, type GraphicBase, type GraphicData } from "./match-graphics";

/** A list with fewer confirmed names than this previews with sample names. */
export const MIN_REAL_LIST_NAMES = 6;
const SAMPLE_COUNT = 18;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sampleNames(lang: Lang | string | null | undefined, count = SAMPLE_COUNT): string[] {
  const word = graphicsCopy(lang).player;
  return Array.from({ length: count }, (_, i) => `${word} ${i + 1}`);
}

export interface PreviewFallback extends GraphicBase {
  teamLabels: [string, string];
}

export interface PreviewGraphic {
  data: GraphicData;
  sample: boolean;
}

/**
 * The real graphic when it shows the design properly, else the sample on
 * the fallback's club, day and labels. `fit.rows`: a measured template's
 * rows, so the sample fits it (two columns of them on the list, exactly
 * that many a side on the team sheet) and the template, not the default,
 * is what the owner sees.
 */
export function previewGraphicData(kind: GraphicKind, real: GraphicData | null, fallback: PreviewFallback, fit?: { rows: number }): PreviewGraphic {
  if (real && real.kind === "list" && kind === "list" && real.players.length >= MIN_REAL_LIST_NAMES) return { data: real, sample: false };
  if (real && real.kind === "teams" && kind === "teams" && real.teams.some((t) => t.names.length > 0)) return { data: real, sample: false };

  const { teamLabels, ...base } = fallback;
  if (kind === "list") {
    const count = fit ? Math.min(SAMPLE_COUNT, fit.rows * 2) : SAMPLE_COUNT;
    return { sample: true, data: { kind: "list", ...base, players: sampleNames(base.lang, count), reserves: [] } };
  }
  const side = fit ? fit.rows : SAMPLE_COUNT / 2;
  const names = sampleNames(base.lang, side * 2);
  return {
    sample: true,
    data: {
      kind: "teams",
      ...base,
      teams: [
        { label: teamLabels[0], names: names.slice(0, side) },
        { label: teamLabels[1], names: names.slice(side) },
      ],
    },
  };
}

/** The preview for a club: its next match's graphic, or the marked sample. Null when the club does not exist. */
export async function loadPreviewGraphic(orgId: string, kind: GraphicKind, now: Date, fit?: { rows: number }): Promise<PreviewGraphic | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { name: true, language: true, teamLabels: true } });
  if (!org) return null;
  const lang = normaliseLang(org.language);
  const matchId = await nextGraphicMatch(orgId, now);
  const match = matchId
    ? await db.match.findFirst({
        where: { id: matchId, activity: { orgId } },
        select: { date: true, teamLabels: true, activity: { select: { venue: true, sport: { select: { teamLabels: true } } } } },
      })
    : null;
  const sport = match ? match.activity.sport : await db.sport.findFirst({ where: { orgId }, select: { teamLabels: true }, orderBy: { createdAt: "asc" } });

  // No match: a week from now at 20:00, London.
  const date = match?.date ?? londonWallClockToUtc(new Date(now.getTime() + 7 * DAY_MS), "20:00");
  const fallback: PreviewFallback = {
    clubName: org.name.trim(),
    lang,
    matchDate: date,
    kickoff: formatLondon(date, "HH:mm"),
    venue: (match?.activity.venue ?? "").trim() || graphicsCopy(lang).sampleVenue,
    teamLabels: resolveTeamLabels(match ?? null, org, sport, lang) as [string, string],
  };
  const real = matchId ? await loadGraphicData({ orgId, matchId, kind }) : null;
  return previewGraphicData(kind, real, fallback, fit);
}
