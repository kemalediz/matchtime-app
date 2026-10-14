/**
 * A CLUB'S GRAPHICS TEMPLATE AND DESIGN, READ FROM THE DATABASE
 * (2026-10-14; designs, sharing and uploads added the same day for the
 * "Posters" card).
 *
 * One `ClubGraphicsTemplate` row per club at most, of one of two kinds:
 *   - "measured": a blank background with a layout measured off the
 *     club's own artwork (`club-graphics-layout.ts`); made by MatchTime
 *     and seeded by `scripts/seed-club-graphics-template.ts`, never
 *     committed to the repo (FNF's);
 *   - "background": a picture an owner uploaded on /admin/settings
 *     (`graphics-background.ts`), stored as a 1080 x 1350 JPEG, on which
 *     the default MatchTime board is drawn.
 * A template may be marked `shared` by the platform owner, with a
 * `displayName`; other clubs can then pick it (`ClubGraphicsChoice`). A
 * shared template may carry a shared VARIANT (`sharedImage`,
 * `sharedLayout`): the same board with its club's branding painted out,
 * which is what other clubs get (FNF's "Floodlights"); the club itself
 * always gets its own `image`.
 *
 * Which design a graphic is drawn in is `loadClubDesign`, by the rules
 * in `club-graphics-choice.ts`.
 *
 * Anything but a usable template reads as null, and the graphic is drawn
 * in the default MatchTime design: no row, a layout this code cannot
 * draw, an image type the renderer does not take, or the tables not
 * there yet (the migrations are applied by hand). A broken template is
 * logged with the club's id only; it never fails the graphic.
 *
 * DEPLOYED BEFORE ITS MIGRATION: if the columns added on 2026-10-14
 * (kind, shared, displayName) are not there yet, the template is read the
 * old way, as a measured one, and the missing choice table reads as "no
 * choice"; so FNF's board keeps working whichever goes first.
 */
import { db } from "./db";
import { parseClubGraphicsLayout, type ClubGraphicsLayout } from "./club-graphics-layout";
import {
  designOptions,
  parseDesignId,
  resolveDesign,
  type DesignKind,
  type DesignOption,
  type StoredChoice,
  type TemplateMeta,
} from "./club-graphics-choice";

export type ClubGraphicsTemplate =
  | { kind: "measured"; image: Buffer; mimeType: "image/jpeg" | "image/png"; layout: ClubGraphicsLayout }
  | { kind: "background"; image: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number };

const TYPES = new Set(["image/jpeg", "image/png"]);
const KINDS = new Set<DesignKind>(["measured", "background"]);

interface Row {
  orgId: string;
  image: Uint8Array;
  mimeType: string;
  layout: unknown;
  kind: string;
  shared: boolean;
  displayName: string | null;
  sharedImage?: Uint8Array | null;
  sharedMimeType?: string | null;
  sharedLayout?: unknown;
}

const FULL_SELECT = {
  orgId: true,
  image: true,
  mimeType: true,
  layout: true,
  kind: true,
  shared: true,
  displayName: true,
  sharedImage: true,
  sharedMimeType: true,
  sharedLayout: true,
} as const;
const LEGACY_SELECT = { orgId: true, image: true, mimeType: true, layout: true } as const;

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 120) : "unknown");

async function readTemplateRow(orgId: string): Promise<Row | null> {
  try {
    return (await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: FULL_SELECT })) as Row | null;
  } catch (err) {
    // The 2026-10-14 columns not there yet: read the old way.
    try {
      const old = (await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: LEGACY_SELECT })) as Omit<Row, "kind" | "shared" | "displayName"> | null;
      return old ? { ...old, kind: "measured", shared: false, displayName: null } : null;
    } catch {
      console.error(`[graphics] template read failed org=${orgId}: ${short(err)}`);
      return null;
    }
  }
}

async function readChoice(orgId: string): Promise<StoredChoice | null> {
  try {
    const row = await db.clubGraphicsChoice.findUnique({ where: { orgId }, select: { design: true, sharedFromOrgId: true } });
    if (!row || !["matchtime", "own", "shared"].includes(row.design)) return null;
    return { design: row.design as StoredChoice["design"], sharedFromOrgId: row.sharedFromOrgId };
  } catch (err) {
    console.error(`[graphics] design choice read failed org=${orgId}: ${short(err)}`);
    return null;
  }
}

function meta(row: Row | null): TemplateMeta | null {
  if (!row || !KINDS.has(row.kind as DesignKind)) return null;
  return { orgId: row.orgId, kind: row.kind as DesignKind, shared: row.shared, displayName: row.displayName };
}

function toTemplate(row: Row | null): ClubGraphicsTemplate | null {
  if (!row) return null;
  const image = Buffer.from(row.image);
  const usableImage = TYPES.has(row.mimeType) && image.length > 0;
  const mimeType = row.mimeType as "image/jpeg" | "image/png";
  if (row.kind === "measured") {
    const layout = parseClubGraphicsLayout(row.layout);
    if (layout && usableImage) return { kind: "measured", image, mimeType, layout };
    console.error(`[graphics] template unusable org=${row.orgId} kind=measured type=${row.mimeType} bytes=${image.length} layout=${layout ? "ok" : "invalid"}`);
    return null;
  }
  if (row.kind === "background") {
    const l = (row.layout ?? {}) as { width?: unknown; height?: unknown };
    const width = typeof l.width === "number" && l.width > 0 ? l.width : 1080;
    const height = typeof l.height === "number" && l.height > 0 ? l.height : 1350;
    if (usableImage) return { kind: "background", image, mimeType, width, height };
    console.error(`[graphics] template unusable org=${row.orgId} kind=background type=${row.mimeType} bytes=${image.length}`);
    return null;
  }
  console.error(`[graphics] template unusable org=${row.orgId} kind=unknown`);
  return null;
}

/** The club's OWN template, usable, or null. */
export async function loadClubGraphicsTemplate(orgId: string): Promise<ClubGraphicsTemplate | null> {
  return toTemplate(await readTemplateRow(orgId));
}

export interface ClubDesign {
  source: "matchtime" | "own" | "shared";
  /** Null: the default MatchTime design. */
  template: ClubGraphicsTemplate | null;
  /** Drawn for a club that is not the template's: its title dropped, its brand area covered. */
  foreign: boolean;
}

const DEFAULT_DESIGN: ClubDesign = { source: "matchtime", template: null, foreign: false };

/**
 * What another club gets of a shared template: its shared VARIANT when it
 * has one (the board with the club's branding painted out, FNF's
 * "Floodlights"), else the template itself (its brand area covered when
 * drawn). A variant that cannot be drawn is never replaced by the branded
 * original: the default design instead.
 */
function toForeignTemplate(row: Row | null): ClubGraphicsTemplate | null {
  if (!row?.sharedImage || row.sharedImage.length === 0) return toTemplate(row);
  return toTemplate({ ...row, kind: "measured", image: row.sharedImage, mimeType: row.sharedMimeType ?? "", layout: row.sharedLayout });
}

function designFrom(source: "own" | "shared", row: Row | null): ClubDesign {
  const template = source === "shared" ? toForeignTemplate(row) : toTemplate(row);
  return template ? { source, template, foreign: source === "shared" } : DEFAULT_DESIGN;
}

/** The design the club's graphics are drawn in now. */
export async function loadClubDesign(orgId: string): Promise<ClubDesign> {
  const [choice, own] = await Promise.all([readChoice(orgId), readTemplateRow(orgId)]);
  const sharedId = choice?.design === "shared" && choice.sharedFromOrgId && choice.sharedFromOrgId !== orgId ? choice.sharedFromOrgId : null;
  const shared = sharedId ? await readTemplateRow(sharedId) : null;
  const pick = resolveDesign({ orgId, choice, own: meta(own), shared: meta(shared) });
  if (pick.source === "matchtime") return DEFAULT_DESIGN;
  return pick.source === "own" ? designFrom("own", own) : designFrom("shared", shared);
}

/** One gallery option for this club, or null when it is not one this club may use. */
export async function loadClubDesignById(orgId: string, id: string): Promise<ClubDesign | null> {
  const parsed = parseDesignId(id);
  if (!parsed) return null;
  if (parsed.source === "matchtime") return DEFAULT_DESIGN;
  if (parsed.source === "own") {
    const row = await readTemplateRow(orgId);
    return row ? designFrom("own", row) : null;
  }
  if (parsed.templateOrgId === orgId) return null;
  const row = await readTemplateRow(parsed.templateOrgId);
  if (!row || !row.shared) return null;
  return designFrom("shared", row);
}

/** Every template other clubs may pick: meta only, never the image bytes. */
async function readSharedMetas(): Promise<TemplateMeta[]> {
  try {
    const rows = await db.clubGraphicsTemplate.findMany({
      where: { shared: true },
      select: { orgId: true, kind: true, shared: true, displayName: true },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map((r) => meta({ ...r, image: new Uint8Array(), mimeType: "", layout: null })).filter((m): m is TemplateMeta => !!m);
  } catch (err) {
    console.error(`[graphics] shared templates read failed: ${short(err)}`);
    return [];
  }
}

export interface ClubDesignState {
  /** The gallery id of the design in force. */
  current: string;
  options: DesignOption[];
  own: { kind: DesignKind } | null;
}

/** The Posters card's gallery: what the club may pick, and what it uses now. */
export async function loadClubDesignState(orgId: string): Promise<ClubDesignState> {
  const [choice, own, shared] = await Promise.all([readChoice(orgId), readTemplateRow(orgId), readSharedMetas()]);
  const ownMeta = meta(own);
  const options = designOptions(orgId, ownMeta, shared);
  const pickedShared = choice?.design === "shared" && choice.sharedFromOrgId ? shared.find((s) => s.orgId === choice.sharedFromOrgId) ?? null : null;
  const pick = resolveDesign({ orgId, choice, own: ownMeta, shared: pickedShared });
  // An own template that cannot be drawn is drawn as the default: say so.
  const ownUsable = pick.source !== "own" || toTemplate(own) !== null;
  const current = !ownUsable ? "matchtime" : pick.source === "shared" ? `shared:${pick.templateOrgId}` : pick.source;
  return { current, options, own: ownMeta ? { kind: ownMeta.kind } : null };
}
