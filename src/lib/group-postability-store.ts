/**
 * `GroupPostState`: every read and write of it (2026-10-14).
 *
 * SAFE BEFORE THE MIGRATION. The table is new
 * (prisma/migrations/20261014120000_group_post_state); every function here
 * catches, so a database without it reads as "no reading": nothing gated,
 * nobody told, admin notices routed exactly as before. Writers return
 * false instead of throwing.
 *
 * Nothing here decides anything; group-postability-rules.ts does. Nothing
 * here is logged but group ids and booleans.
 */
import { db } from "./db";
import type { PostabilityInput, PostabilityReason } from "./group-postability-rules";

export interface PostStateRow {
  groupId: string;
  announce: boolean;
  communityAnnounce: boolean;
  botIsAdmin: boolean;
  canPost: boolean;
  blockedSince: Date | null;
  noticeSentAt: Date | null;
  heldConnectId: string | null;
  heldAdd: unknown;
  heldAt: Date | null;
}

/** What a held group add keeps, to finish the link with later. */
export interface HeldAdd {
  /** A first link of a request, or a relink after a re-add (group-add.ts). */
  kind: "first" | "relink";
  /** The request's status when the add matched it: the link's compare-and-set. */
  status: string;
  /** For a relink: the removal it relinks after (ISO). */
  removedAt?: string | null;
  subject: string | null;
  addedByPhone: string | null;
  addedByLid: string | null;
  /** The Pi's participant snapshot, as it was posted. */
  participants: unknown;
  adderMatch: string;
  organiserPresent: boolean;
  reason: Exclude<PostabilityReason, "ok">;
}

function table(): {
  findUnique: (a: unknown) => Promise<unknown>;
  upsert: (a: unknown) => Promise<unknown>;
  updateMany: (a: unknown) => Promise<{ count: number }>;
} | null {
  const t = (db as unknown as { groupPostState?: unknown }).groupPostState;
  return t ? (t as ReturnType<typeof table>) : null;
}

function errName(err: unknown): string {
  return err instanceof Error ? `${err.name}${(err as { code?: string }).code ? ` ${(err as { code?: string }).code}` : ""}` : "error";
}

export async function readPostState(groupId: string): Promise<PostStateRow | null> {
  try {
    const t = table();
    if (!t) return null;
    return ((await t.findUnique({ where: { groupId } })) as PostStateRow | null) ?? null;
  } catch (err) {
    console.error(`[group-postability] could not read ${groupId} (${errName(err)}); treated as no reading`);
    return null;
  }
}

/**
 * Can MatchTime post in this group, as far as the server knows? True when
 * there is no reading (never read, no table yet, no group): only a reading
 * that says it cannot is believed.
 */
export async function isGroupPostable(groupId: string | null | undefined): Promise<boolean> {
  if (!groupId) return true;
  const row = await readPostState(groupId);
  return row ? row.canPost !== false : true;
}

/** Store a reading and its stretch. False when it could not be written. */
export async function writePostReading(args: {
  groupId: string;
  input: PostabilityInput;
  canPost: boolean;
  blockedSince: Date | null;
  /** null clears it (a stretch ended); undefined leaves it. */
  noticeSentAt?: Date | null;
  now: Date;
}): Promise<boolean> {
  const { groupId, input, canPost, blockedSince, now } = args;
  const fields = {
    announce: input.announce,
    communityAnnounce: input.communityAnnounce,
    botIsAdmin: input.botIsAdmin,
    canPost,
    blockedSince,
    observedAt: now,
    ...(args.noticeSentAt !== undefined ? { noticeSentAt: args.noticeSentAt } : {}),
  };
  try {
    const t = table();
    if (!t) return false;
    await t.upsert({ where: { groupId }, create: { groupId, ...fields }, update: fields });
    return true;
  } catch (err) {
    console.error(`[group-postability] could not store ${groupId} (${errName(err)})`);
    return false;
  }
}

export async function markNoticeSent(groupId: string, now: Date): Promise<void> {
  try {
    await table()?.updateMany({ where: { groupId }, data: { noticeSentAt: now } });
  } catch (err) {
    console.error(`[group-postability] could not mark ${groupId} told (${errName(err)})`);
  }
}

/** Put a connect request's add here on hold. False when it could not be stored. */
export async function holdGroupAdd(args: {
  groupId: string;
  connectId: string;
  held: HeldAdd;
  input: PostabilityInput;
  now: Date;
}): Promise<boolean> {
  const { groupId, connectId, held, input, now } = args;
  const fields = {
    announce: input.announce,
    communityAnnounce: input.communityAnnounce,
    botIsAdmin: input.botIsAdmin,
    canPost: false,
    observedAt: now,
    heldConnectId: connectId,
    heldAdd: held as unknown as object,
    heldAt: now,
  };
  try {
    const t = table();
    if (!t) return false;
    await t.upsert({ where: { groupId }, create: { groupId, blockedSince: now, ...fields }, update: fields });
    return true;
  } catch (err) {
    console.error(`[group-postability] could not hold the add in ${groupId} (${errName(err)})`);
    return false;
  }
}

/** The hold is over (finished, or it can no longer be). Only if it is still this request's. */
export async function clearHeldAdd(groupId: string, connectId: string): Promise<void> {
  try {
    // Raw, as captured-chat.ts clears its JSON: a JSON column is set to SQL
    // NULL this way without Prisma's JSON-null sentinels.
    await db.$executeRaw`UPDATE "GroupPostState" SET "heldConnectId" = NULL, "heldAdd" = NULL, "heldAt" = NULL, "updatedAt" = NOW()
      WHERE "groupId" = ${groupId} AND "heldConnectId" = ${connectId}`;
  } catch (err) {
    console.error(`[group-postability] could not clear the hold in ${groupId} (${errName(err)})`);
  }
}

/** A stored held add, read defensively; null when it is not one. */
export function parseHeldAdd(raw: unknown): HeldAdd | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (h.kind !== "first" && h.kind !== "relink") return null;
  if (typeof h.status !== "string" || typeof h.adderMatch !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    kind: h.kind,
    status: h.status,
    removedAt: str(h.removedAt),
    subject: str(h.subject),
    addedByPhone: str(h.addedByPhone),
    addedByLid: str(h.addedByLid),
    participants: h.participants,
    adderMatch: h.adderMatch,
    organiserPresent: h.organiserPresent === true,
    reason: h.reason === "community-announce" ? "community-announce" : "admin-only",
  };
}
