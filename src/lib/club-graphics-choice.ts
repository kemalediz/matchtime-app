/**
 * WHICH DESIGN A CLUB'S LIST POSTER AND TEAM SHEET ARE DRAWN IN
 * (2026-10-14, the "Posters" card on /admin/settings). Pure: no database.
 *
 * Three sources:
 *   - "matchtime": the default MatchTime design (`match-graphics-render.tsx`);
 *   - "own": the club's own template (`ClubGraphicsTemplate` keyed by its
 *     org id): a MEASURED one made by MatchTime from the club's artwork
 *     (FNF's), or a BACKGROUND an owner uploaded;
 *   - "shared": another club's template that the platform owner has marked
 *     shared. It is drawn with the picking club's own name and data, and
 *     always as "foreign": its own squad title is dropped and its
 *     `brandArea` covered, so nothing of the other club is on the picture.
 *
 * THE RULE (`resolveDesign`): what the club picked, when it is still
 * available; otherwise its own template when it has one; otherwise the
 * default. So a club that never picked (FNF today) keeps its own template,
 * a picked shared template that is withdrawn or deleted falls back to the
 * club's own and then the default, and another club's PRIVATE template is
 * never used or offered.
 *
 * Ids in the gallery and the API: "matchtime", "own", "shared:<orgId>".
 */
import type { ClubGraphicsLayout } from "./club-graphics-layout";

export type DesignKind = "measured" | "background";

/** What the rules need to know about a stored template. */
export interface TemplateMeta {
  orgId: string;
  kind: DesignKind;
  shared: boolean;
  displayName: string | null;
}

/** A club's stored choice (`ClubGraphicsChoice`). */
export interface StoredChoice {
  design: "matchtime" | "own" | "shared";
  /** The template's club for "shared"; null once that template is deleted. */
  sharedFromOrgId: string | null;
}

export type DesignPick = { source: "matchtime" } | { source: "own"; templateOrgId: string } | { source: "shared"; templateOrgId: string };

export function resolveDesign(args: {
  orgId: string;
  choice: StoredChoice | null;
  own: TemplateMeta | null;
  /** The template the choice points at, when it is "shared". */
  shared: TemplateMeta | null;
}): DesignPick {
  const { orgId, choice } = args;
  const own = args.own && args.own.orgId === orgId ? args.own : null;
  const fallback: DesignPick = own ? { source: "own", templateOrgId: orgId } : { source: "matchtime" };

  if (choice?.design === "matchtime") return { source: "matchtime" };
  if (choice?.design === "shared") {
    const s = args.shared;
    if (s && choice.sharedFromOrgId && s.orgId === choice.sharedFromOrgId && s.orgId !== orgId && s.shared) {
      return { source: "shared", templateOrgId: s.orgId };
    }
  }
  return fallback;
}

export interface DesignOption {
  id: string;
  source: DesignPick["source"];
  kind: DesignKind | null;
  /** A shared template's display name; null: the page names it ("Your design", "Shared design 2"). */
  label: string | null;
}

/** The gallery: MatchTime, the club's own template if any, then every template other clubs share. */
export function designOptions(orgId: string, own: TemplateMeta | null, shared: readonly TemplateMeta[]): DesignOption[] {
  const out: DesignOption[] = [{ id: "matchtime", source: "matchtime", kind: null, label: null }];
  if (own && own.orgId === orgId) out.push({ id: "own", source: "own", kind: own.kind, label: null });
  for (const s of shared) {
    if (!s.shared || s.orgId === orgId) continue;
    out.push({ id: `shared:${s.orgId}`, source: "shared", kind: s.kind, label: s.displayName?.trim() || null });
  }
  return out;
}

export type ParsedDesignId = { source: "matchtime" } | { source: "own" } | { source: "shared"; templateOrgId: string };

/** A gallery id, or null for anything that is not one. */
export function parseDesignId(id: unknown): ParsedDesignId | null {
  if (typeof id !== "string") return null;
  if (id === "matchtime") return { source: "matchtime" };
  if (id === "own") return { source: "own" };
  const m = /^shared:([A-Za-z0-9_-]{1,64})$/.exec(id);
  return m ? { source: "shared", templateOrgId: m[1] } : null;
}

export const DISPLAY_NAME_MAX = 40;

const squeeze = (s: string) =>
  s
    .normalize("NFKC")
    .toLocaleLowerCase("tr")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What other clubs see a shared template called. It must not carry the
 * club's own name: sharing is about the look, never about whose it was.
 */
export function displayNameProblem(displayName: string, clubName: string): "empty" | "too-long" | "names-club" | null {
  const name = displayName.replace(/\s+/g, " ").trim();
  if (!name) return "empty";
  if (name.length > DISPLAY_NAME_MAX) return "too-long";
  const club = squeeze(clubName);
  if (club && squeeze(name).includes(club)) return "names-club";
  return null;
}

/** A shared measured template's layout for another club: its own squad title (it may name its club) dropped. */
export function foreignLayout(layout: ClubGraphicsLayout): ClubGraphicsLayout {
  const { title: _title, ...squadHeader } = layout.squadHeader;
  void _title;
  return { ...layout, squadHeader };
}
