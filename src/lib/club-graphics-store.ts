/**
 * CHANGING A CLUB'S POSTER DESIGN (2026-10-14, the "Posters" card and the
 * platform owner's /admin/clubs).
 *
 *   selectClubDesign     an owner or admin picks a gallery option; only an
 *                        option this club is offered is stored (another
 *                        club's private template cannot be picked by id);
 *   saveClubBackground   an owner or admin uploads a picture: checked and
 *                        re-encoded (`graphics-background.ts`), stored as
 *                        the club's own template of kind "background", and
 *                        picked. It replaces an earlier upload; it never
 *                        replaces a template MatchTime made for the club
 *                        (kind "measured", FNF's), which is refused;
 *   removeClubBackground the upload deleted; the club is back on the
 *                        default (or the shared design it picked);
 *   setTemplateSharing   the platform owner shares a club's template with
 *                        other clubs under a display name that does not
 *                        carry the club's name, or stops sharing it.
 *
 * Callers authorise first (`club-graphics-access.ts`, superadmin for
 * sharing). Nothing here logs a name; the log lines carry ids and sizes.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { loadClubDesignState } from "./club-graphics-template";
import { displayNameProblem, parseDesignId } from "./club-graphics-choice";
import { prepareBackground, type BackgroundProblem } from "./graphics-background";

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 120) : "unknown");

export type SelectDesignResult = { ok: true; current: string } | { ok: false; error: "unavailable" | "failed" };

export async function selectClubDesign(orgId: string, id: unknown, userId: string): Promise<SelectDesignResult> {
  const parsed = parseDesignId(id);
  if (!parsed) return { ok: false, error: "unavailable" };
  const state = await loadClubDesignState(orgId);
  if (!state.options.some((o) => o.id === id)) return { ok: false, error: "unavailable" };
  const data = {
    design: parsed.source,
    sharedFromOrgId: parsed.source === "shared" ? parsed.templateOrgId : null,
    updatedById: userId,
  };
  try {
    await db.clubGraphicsChoice.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  } catch (err) {
    console.error(`[graphics] design choice write failed org=${orgId}: ${short(err)}`);
    return { ok: false, error: "failed" };
  }
  console.log(`[graphics] design chosen org=${orgId} design=${parsed.source}${parsed.source === "shared" ? ` from=${parsed.templateOrgId}` : ""}`);
  return { ok: true, current: id as string };
}

export type BackgroundUploadResult = { ok: true } | { ok: false; problem: BackgroundProblem | "made-by-matchtime" | "failed" };

async function ownKind(orgId: string): Promise<string | null> {
  const row = await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: { kind: true } });
  return row?.kind ?? null;
}

export async function saveClubBackground(orgId: string, bytes: Uint8Array, claimedType: string | null, userId: string): Promise<BackgroundUploadResult> {
  try {
    if ((await ownKind(orgId)) === "measured") return { ok: false, problem: "made-by-matchtime" };
  } catch (err) {
    console.error(`[graphics] background upload failed org=${orgId}: ${short(err)}`);
    return { ok: false, problem: "failed" };
  }
  const prepared = await prepareBackground(bytes, claimedType);
  if (!prepared.ok) {
    console.log(`[graphics] background refused org=${orgId} problem=${prepared.problem} bytes=${bytes.length}`);
    return prepared;
  }
  const template = {
    image: new Uint8Array(prepared.image),
    mimeType: prepared.mimeType,
    layout: { width: prepared.width, height: prepared.height },
    kind: "background",
    // A new picture is not what the platform owner agreed to share.
    shared: false,
    displayName: null,
    sharedImage: null,
    sharedMimeType: null,
    sharedLayout: Prisma.DbNull,
  };
  const choice = { design: "own", sharedFromOrgId: null, updatedById: userId };
  try {
    await db.$transaction([
      db.clubGraphicsTemplate.upsert({ where: { orgId }, create: { orgId, ...template }, update: template }),
      db.clubGraphicsChoice.upsert({ where: { orgId }, create: { orgId, ...choice }, update: choice }),
    ]);
  } catch (err) {
    console.error(`[graphics] background save failed org=${orgId}: ${short(err)}`);
    return { ok: false, problem: "failed" };
  }
  console.log(`[graphics] background saved org=${orgId} in=${bytes.length} stored=${prepared.image.length} type=${prepared.mimeType}`);
  return { ok: true };
}

export type BackgroundRemoveResult = { ok: true } | { ok: false; error: "none" | "made-by-matchtime" | "failed" };

export async function removeClubBackground(orgId: string): Promise<BackgroundRemoveResult> {
  try {
    const kind = await ownKind(orgId);
    if (!kind) return { ok: false, error: "none" };
    if (kind !== "background") return { ok: false, error: "made-by-matchtime" };
    await db.$transaction([
      db.clubGraphicsChoice.deleteMany({ where: { orgId, design: "own" } }),
      db.clubGraphicsTemplate.delete({ where: { orgId } }),
    ]);
  } catch (err) {
    console.error(`[graphics] background remove failed org=${orgId}: ${short(err)}`);
    return { ok: false, error: "failed" };
  }
  console.log(`[graphics] background removed org=${orgId}`);
  return { ok: true };
}

export type SharingResult = { ok: true } | { ok: false; error: "none" | "empty" | "too-long" | "names-club" | "failed" };

/** The platform owner only: callers check `isSuperadmin`. */
export async function setTemplateSharing(orgId: string, shared: boolean, displayName: string | null): Promise<SharingResult> {
  const row = await db.clubGraphicsTemplate.findUnique({ where: { orgId }, select: { org: { select: { name: true } } } });
  if (!row) return { ok: false, error: "none" };
  const name = (displayName ?? "").replace(/\s+/g, " ").trim();
  if (shared) {
    const problem = displayNameProblem(name, row.org.name);
    if (problem) return { ok: false, error: problem };
  }
  try {
    await db.clubGraphicsTemplate.update({ where: { orgId }, data: { shared, displayName: shared ? name : name || null } });
  } catch (err) {
    console.error(`[graphics] sharing write failed org=${orgId}: ${short(err)}`);
    return { ok: false, error: "failed" };
  }
  console.log(`[graphics] template sharing org=${orgId} shared=${shared}`);
  return { ok: true };
}
