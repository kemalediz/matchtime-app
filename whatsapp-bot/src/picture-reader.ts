/**
 * PICTURE READING, the Pi's half (2026-10-14).
 *
 * Clubs post the weekly list and the team sheet as designed pictures. The
 * Baileys driver hands every picture in a monitored group to `handle`
 * INSTEAD of straight up, and this decides what goes up:
 *
 *   1. ask the server whether this picture may be read (`check`: club,
 *      flag, owner or admin by phone or LID, or a game-like caption, and
 *      the club's daily picture cap). No picture is sent with the question;
 *   2. on a yes, download the picture into memory, shrink it, and send it
 *      once (`read`);
 *   3. hand the message up ONCE: with the transcript in place of (or under)
 *      the caption when there is one, otherwise exactly as it arrived.
 *
 * The message keeps its own id, so a reaction lands on the picture and the
 * server's dedupe treats it as the one message it is. Downstream it is then
 * exactly as if the sender had typed "[Picture] Poster: ...".
 *
 * NOTHING CAN LOSE THE MESSAGE. Every failure (a refused or unanswered
 * check, a failed download, a model error, a deadline) hands the original
 * message up unchanged, and a guard makes "once" true whatever settles
 * late.
 *
 * NOTHING IS KEPT. The picture lives in this function's memory until the
 * read returns. It is never written to disk and never logged; nor are its
 * caption, its media key, its URL, its hash or the transcript. The log
 * says message ids, sizes, counts and outcomes.
 */
import type { InboundMessage } from "./driver.js";

/** A bound on downloads even if the server's cap fails open. The server's is 10. */
export const MAX_PICTURES_PER_GROUP_PER_DAY = 10;
/** The whole check-download-read, before the message goes up as it was. */
export const PICTURE_DEADLINE_MS = 60_000;
/** After the server says the switch is off, how long before asking again. */
export const FLAG_OFF_QUIET_MS = 10 * 60 * 1000;

export interface PictureMetaForServer {
  groupId: string;
  waMessageId: string;
  senderPhone: string | null;
  senderAltPhone: string | null;
  senderLid: string | null;
  caption: string;
}

export interface PictureImage {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface PictureReaderDeps {
  isMonitored(groupId: string): boolean;
  check(meta: PictureMetaForServer): Promise<{ read: boolean; reason?: string } | null>;
  /** The picture's bytes, in memory, or null when it is over the size cap. */
  download(raw: unknown): Promise<Buffer | null>;
  shrink(bytes: Buffer): Promise<PictureImage | null>;
  read(meta: PictureMetaForServer, image: PictureImage): Promise<{ read: boolean; transcript?: string | null; reason?: string } | null>;
  log?(line: string): void;
  now?(): number;
  schedule?(fn: () => void, ms: number): { cancel(): void };
}

export interface PictureReader {
  /** Is this a picture the reader should be handed? Cheap and synchronous. */
  wants(view: InboundMessage): boolean;
  /** Never throws; calls `handUp` exactly once. */
  handle(view: InboundMessage, raw: unknown, handUp: (view: InboundMessage) => void): void;
}

type Viewish = {
  id?: { _serialized?: unknown };
  from?: unknown;
  fromMe?: unknown;
  type?: unknown;
  body?: unknown;
  _data?: Record<string, unknown>;
  baileys?: { senderPhone?: unknown; altPhone?: unknown; senderLid?: unknown };
};

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function pictureMetaOf(view: InboundMessage): PictureMetaForServer {
  const v = view as unknown as Viewish;
  return {
    groupId: s(v.from) ?? "",
    waMessageId: s(v.id?._serialized) ?? "",
    senderPhone: s(v.baileys?.senderPhone),
    senderAltPhone: s(v.baileys?.altPhone),
    senderLid: s(v.baileys?.senderLid),
    caption: typeof v.body === "string" ? v.body : "",
  };
}

/** A copy of the view with the transcript as its text (under the caption, if any). */
export function withTranscript(view: InboundMessage, transcript: string): InboundMessage {
  const v = view as unknown as Viewish;
  const caption = typeof v.body === "string" ? v.body.trim() : "";
  const body = caption ? `${caption}\n${transcript}` : transcript;
  // Object.assign copies own symbol keys too: the raw message rides along.
  const copy = Object.assign({}, view) as unknown as Viewish;
  copy.body = body;
  copy._data = { ...(v._data ?? {}), body };
  return copy as unknown as InboundMessage;
}

export function createPictureReader(deps: PictureReaderDeps): PictureReader {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
  let quietUntil = 0;
  /** groupId -> [UTC day, downloads that day]. */
  const downloads = new Map<string, [string, number]>();

  const dayOf = () => new Date(now()).toISOString().slice(0, 10);
  function underCap(groupId: string): boolean {
    const d = downloads.get(groupId);
    return !d || d[0] !== dayOf() || d[1] < MAX_PICTURES_PER_GROUP_PER_DAY;
  }
  function countDownload(groupId: string): void {
    const d = downloads.get(groupId);
    const today = dayOf();
    downloads.set(groupId, d && d[0] === today ? [today, d[1] + 1] : [today, 1]);
    if (downloads.size > 500) downloads.delete(downloads.keys().next().value as string);
  }

  function wants(view: InboundMessage): boolean {
    try {
      const v = view as unknown as Viewish;
      const from = s(v.from);
      if (!from || !from.endsWith("@g.us") || v.fromMe === true || v.type !== "image") return false;
      if (now() < quietUntil) return false;
      return deps.isMonitored(from);
    } catch {
      return false;
    }
  }

  function handle(view: InboundMessage, raw: unknown, handUp: (view: InboundMessage) => void): void {
    const meta = pictureMetaOf(view);
    const tag = `[picture] ${meta.groupId} ${meta.waMessageId || "?"}`;
    let done = false;
    let timer: { cancel(): void } | null = null;
    const finish = (out: InboundMessage, outcome: string) => {
      if (done) return;
      done = true;
      timer?.cancel();
      log(`${tag}: ${outcome}`);
      try {
        handUp(out);
      } catch (err) {
        log(`${tag}: handing it up failed (${(err as Error)?.name ?? "error"})`);
      }
    };
    try {
      timer = schedule(
        () => finish(view, `handed up as it was: no answer within ${Math.round(PICTURE_DEADLINE_MS / 1000)}s`),
        PICTURE_DEADLINE_MS,
      );
    } catch {
      /* no deadline: every path below still finishes */
    }
    void (async () => {
      if (!meta.groupId || !meta.waMessageId) return finish(view, "handed up as it was: no id");
      if (!underCap(meta.groupId)) return finish(view, `handed up as it was: ${MAX_PICTURES_PER_GROUP_PER_DAY} pictures read in this group today`);
      const asked = await deps.check(meta);
      if (!asked) return finish(view, "handed up as it was: the server did not answer the check");
      if (!asked.read) {
        if (asked.reason === "flag-off") quietUntil = now() + FLAG_OFF_QUIET_MS;
        return finish(view, `handed up as it was: not read (${asked.reason ?? "?"})`);
      }
      if (done) return;
      countDownload(meta.groupId);
      const bytes = await deps.download(raw);
      if (!bytes) return finish(view, "handed up as it was: the picture could not be downloaded or is too large");
      const image = await deps.shrink(bytes);
      if (!image) return finish(view, `handed up as it was: the picture (${bytes.length} bytes) could not be prepared`);
      if (done) return;
      const answer = await deps.read(meta, image);
      if (!answer?.read) return finish(view, `handed up as it was: not read (${answer?.reason ?? "no answer"})`);
      if (!answer.transcript) return finish(view, `handed up as it was: read (${image.data.length} bytes), not about the game`);
      finish(
        withTranscript(view, answer.transcript),
        `handed up with a transcript of ${answer.transcript.length} chars (picture ${bytes.length} bytes, sent ${image.data.length})`,
      );
    })().catch((err) => finish(view, `handed up as it was: ${(err as Error)?.name ?? "error"}`));
  }

  return { wants, handle };
}
