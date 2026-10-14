/**
 * PICTURE READING (2026-10-14), the decision and the one model call.
 *
 * Clubs post key information as designed pictures: the weekly poster of
 * the players with the date, time and venue, a team sheet. The Pi asks
 * here, in two steps, so it never downloads a picture nobody will read:
 *
 *   check  may this picture be read? (no picture sent, nothing counted)
 *   read   the picture itself, in memory: checked again, claimed against
 *          the club's daily picture cap, read by the model inside the
 *          club's daily AI budget, and answered with a transcript.
 *
 * WHICH PICTURES. Only in a club MatchTime serves (approved, bot on, its
 * players' group), and only when PICTURE_READING_ENABLED is on, and only:
 *   - posted by an owner or admin of the club, matched by phone or by a
 *     LID pair the server stored itself (`resolveSenderUserIds`), never by
 *     the pushname; or
 *   - captioned like a list, team sheet or result (picture-words.ts).
 *
 * THE CAPS. At most `PICTURE_DAILY_CAP` pictures per club per London day,
 * counted by claim (one per WhatsApp message id, so a retry is free and
 * read once), and every call spends from the club's ordinary daily AI cap
 * (ai-budget.ts): a club at its cap gets no reading at all.
 *
 * PRIVACY. The picture is never stored and never logged, nor is its
 * caption or its transcript: the log says ids, counts, sizes and outcomes.
 * The transcript goes back to the Pi, which hands it to the analyser as
 * the sender's message, where it is kept exactly like typed text.
 *
 * This file is free of Prisma: the database half is `picture-reading-db.ts`.
 */
import { captionLooksAboutGame } from "./picture-words";
import {
  PICTURE_READING_MAX_TOKENS,
  PICTURE_READING_MODEL,
  PICTURE_READING_SYSTEM_PROMPT,
  PICTURE_READING_USER_TEXT,
} from "./picture-prompt";
import { isAiBudgetExceeded } from "./ai-budget-context";
import { formatLondon } from "./london-time";
import type { ModelRequest, PipelineModel } from "./pipeline/llm";

/** Pictures read per club per London day (Kemal's brief: "a small N, e.g. 10"). */
export const PICTURE_DAILY_CAP = 10;
/** Decoded bytes. The API takes 5 MB per image as base64; the Pi sends a downscaled JPEG far below this. */
export const MAX_PICTURE_BYTES = 3_750_000;
/** What downstream sees first, so it knows the text came from a picture. */
export const PICTURE_TRANSCRIPT_PREFIX = "[Picture]";
/** A transcript, in characters, prefix included. */
export const MAX_TRANSCRIPT_CHARS = 1600;

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
type MediaType = NonNullable<ModelRequest["images"]>[number]["mediaType"];

export interface PictureMeta {
  groupId: string;
  waMessageId: string;
  senderPhone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
  caption?: string | null;
}

export interface PictureSender {
  senderPhone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
}

export interface PictureDeps {
  /** The serving club whose players' group this is, or null. */
  findClub(groupId: string): Promise<{ id: string } | null>;
  isOwnerOrAdmin(orgId: string, sender: PictureSender): Promise<boolean>;
  /** Pictures claimed for this club on this London day. */
  readsToday(orgId: string, day: string): Promise<number>;
  /** Claim one picture. False: this message was claimed already. */
  claim(orgId: string, day: string, waMessageId: string): Promise<boolean>;
  unclaim(orgId: string, day: string, waMessageId: string): Promise<void>;
  /** Run inside the club's daily AI budget scope. */
  withBudget<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
  model: PipelineModel;
}

export type PictureCheck =
  | { read: true; orgId: string; why: "admin" | "caption" }
  | { read: false; reason: "flag-off" | "bad-request" | "no-club"; orgId?: undefined }
  | { read: false; reason: "not-qualifying" | "daily-cap"; orgId: string };

export type PictureRead =
  | { read: true; orgId: string; transcript: string | null; costUsd: number | null }
  | {
      read: false;
      reason: Extract<PictureCheck, { read: false }>["reason"] | "bad-image" | "duplicate" | "ai-cap" | "model-error";
      orgId?: string;
    };

interface Opts {
  enabled: boolean;
  now: Date;
  deps: PictureDeps;
}

const day = (now: Date) => formatLondon(now, "yyyy-MM-dd");

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function checkPicture(meta: PictureMeta, { enabled, now, deps }: Opts): Promise<PictureCheck> {
  if (!enabled) return { read: false, reason: "flag-off" };
  const groupId = str(meta?.groupId);
  if (!groupId || !groupId.endsWith("@g.us") || !str(meta?.waMessageId)) return { read: false, reason: "bad-request" };
  const club = await deps.findClub(groupId);
  if (!club) return { read: false, reason: "no-club" };
  let why: "admin" | "caption" | null = captionLooksAboutGame(meta.caption) ? "caption" : null;
  if (!why) {
    const sender = { senderPhone: str(meta.senderPhone), senderAltPhone: str(meta.senderAltPhone), senderLid: str(meta.senderLid) };
    if ((sender.senderPhone || sender.senderAltPhone || sender.senderLid) && (await deps.isOwnerOrAdmin(club.id, sender))) {
      why = "admin";
    }
  }
  if (!why) return { read: false, reason: "not-qualifying", orgId: club.id };
  if ((await deps.readsToday(club.id, day(now))) >= PICTURE_DAILY_CAP) {
    return { read: false, reason: "daily-cap", orgId: club.id };
  }
  return { read: true, orgId: club.id, why };
}

/** The image as sent, or null when it is not one this route reads. */
function validImage(image: unknown): { data: string; mediaType: MediaType; bytes: number } | null {
  const i = image as { data?: unknown; mediaType?: unknown } | null | undefined;
  if (!i || typeof i.data !== "string" || typeof i.mediaType !== "string") return null;
  if (!MEDIA_TYPES.has(i.mediaType)) return null;
  const data = i.data.trim();
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes <= 0 || bytes > MAX_PICTURE_BYTES) return null;
  return { data, mediaType: i.mediaType as MediaType, bytes };
}

/** The model's text as the transcript, or null for "not about the game". */
export function formatTranscript(text: string | null | undefined): string | null {
  const t = (text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join("\n")
    .trim();
  if (!t || /^not about the game\W*$/i.test(t)) return null;
  const room = MAX_TRANSCRIPT_CHARS - PICTURE_TRANSCRIPT_PREFIX.length - 1;
  return `${PICTURE_TRANSCRIPT_PREFIX} ${t.length > room ? t.slice(0, room).trimEnd() : t}`;
}

function logLine(meta: PictureMeta, what: string): void {
  // Ids and outcomes only. Never the caption, the picture or the transcript.
  console.log(`[picture] ${str(meta?.groupId) ?? "?"} ${str(meta?.waMessageId) ?? "?"}: ${what}`);
}

export async function readPicture(
  req: PictureMeta & { image?: unknown },
  { enabled, now, deps }: Opts,
): Promise<PictureRead> {
  const check = await checkPicture(req, { enabled, now, deps });
  if (!check.read) {
    logLine(req, `not read (${check.reason})`);
    return check;
  }
  const orgId = check.orgId;
  const image = validImage(req.image);
  if (!image) {
    logLine(req, "not read (bad-image)");
    return { read: false, reason: "bad-image", orgId };
  }
  const today = day(now);
  if (!(await deps.claim(orgId, today, req.waMessageId))) {
    logLine(req, "not read (duplicate: this message was read already)");
    return { read: false, reason: "duplicate", orgId };
  }
  // The claim is counted with everyone else's: a read that lands past the
  // cap (two arrived at once) gives its claim back and is not made.
  if ((await deps.readsToday(orgId, today)) > PICTURE_DAILY_CAP) {
    await deps.unclaim(orgId, today, req.waMessageId);
    logLine(req, "not read (daily-cap, reached while it was being claimed)");
    return { read: false, reason: "daily-cap", orgId };
  }
  try {
    const resp = await deps.withBudget(orgId, () =>
      deps.model.complete({
        model: PICTURE_READING_MODEL,
        system: PICTURE_READING_SYSTEM_PROMPT,
        user: PICTURE_READING_USER_TEXT,
        maxTokens: PICTURE_READING_MAX_TOKENS,
        label: "picture-reading",
        images: [{ mediaType: image.mediaType, data: image.data }],
      }),
    );
    const transcript = formatTranscript(resp.text);
    logLine(
      req,
      `read (${check.why}, ${image.mediaType}, ${image.bytes} bytes): ` +
        `${transcript ? `transcript of ${transcript.length} chars` : "not about the game"}; ` +
        `$${(resp.costUsd ?? 0).toFixed(4)}`,
    );
    return { read: true, orgId, transcript, costUsd: resp.costUsd };
  } catch (err) {
    const capped = isAiBudgetExceeded(err);
    // The claim is kept: a retry of a picture that failed is not read twice.
    console.error(
      `[picture] ${req.groupId} ${req.waMessageId}: not read (${capped ? "ai-cap" : "model-error"}: ${(err as Error)?.name ?? "error"})`,
    );
    return { read: false, reason: capped ? "ai-cap" : "model-error", orgId };
  }
}
