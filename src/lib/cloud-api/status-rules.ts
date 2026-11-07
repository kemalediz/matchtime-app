/**
 * META'S STATUS UPDATES, APPLIED TO A CLOUD JOB (WhatsApp Cloud API plan,
 * PR C5; MDs/whatsapp-cloud-api-plan-2026-11-04.md sections 5.2 and 5.5).
 * Pure: the job as it is and one status in, the columns to write out (or
 * null: nothing to write). The webhook (`webhook.ts`) writes the answer
 * with a compare-and-set on the job's status as it was read.
 *
 * IDEMPOTENT. Meta repeats statuses for up to 7 days and may send them out
 * of order, so a column is written only while it is empty and a state only
 * moves forward: the same status twice writes nothing the second time.
 *
 *   sent       settles a job the dispatcher could not confirm.
 *   delivered  `deliveredAt`, once; settles too.
 *   read       `readAt`, once, and `deliveredAt` if delivered never came.
 *   failed     the job is failed with Meta's code, unless it was already
 *              delivered or read (it reached him; that wins).
 *
 * WHICH JOBS. `sent` (the normal case), and the two the dispatcher did not
 * finish: `unconfirmed` (no answer from Meta, it may have landed; plan
 * 5.5) and `claimed` (the status beat the dispatcher's own write, which
 * then finds the job settled and writes nothing). Never a `queued` job
 * (back in the queue for a retry or a hand over: no live message) and never
 * a `failed` one. A job already holding another wamid is another message.
 */
import type { CloudStatusUpdate } from "./inbound";

export interface StatusJobView {
  id: string;
  status: string;
  waMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
}

export interface StatusWrite {
  data: {
    status?: "sent" | "failed";
    waMessageId?: string;
    sentAt?: Date;
    deliveredAt?: Date;
    readAt?: Date;
    failedAt?: Date;
    errorCode?: number | null;
    failReason?: string;
  };
  /** Columns that must still be empty when the write lands (review of
   *  #554, item 5): every gap `data` fills, and for a failure delivered
   *  and read too. Added to the compare-and-set beside the status. */
  guard: { waMessageId?: null; sentAt?: null; deliveredAt?: null; readAt?: null };
  /** The job's outcome changed: the pool's hooks follow it. */
  settles: "sent" | "failed" | null;
}

const GAP_COLUMNS = ["waMessageId", "sentAt", "deliveredAt", "readAt"] as const;

/** Every gap the write fills must still be a gap when it lands. */
function guardOf(data: StatusWrite["data"], extra: StatusWrite["guard"] = {}): StatusWrite["guard"] {
  const guard: StatusWrite["guard"] = { ...extra };
  for (const col of GAP_COLUMNS) if (col in data) guard[col] = null;
  return guard;
}

const FAIL_REASON_MAX = 500;
const UNSETTLED = new Set(["claimed", "unconfirmed"]);
const LIVE = new Set(["claimed", "unconfirmed", "sent"]);

export function cloudStatusUpdate(job: StatusJobView, st: CloudStatusUpdate, now: Date): StatusWrite | null {
  if (!LIVE.has(job.status)) return null;
  if (job.waMessageId && job.waMessageId !== st.wamid) return null;
  const at = st.at ?? now;
  const wamid = job.waMessageId ? {} : { waMessageId: st.wamid };

  if (st.status === "failed") {
    if (job.deliveredAt || job.readAt) return null;
    const reason = `Meta status failed: ${st.errorCode ?? "no code"}${st.errorTitle ? ` ${st.errorTitle}` : ""}`;
    const data: StatusWrite["data"] = { status: "failed", failedAt: at, errorCode: st.errorCode, failReason: reason.slice(0, FAIL_REASON_MAX), ...wamid };
    // Delivered or read landing first wins, even when it races this write.
    return { data, guard: guardOf(data, { deliveredAt: null, readAt: null }), settles: "failed" };
  }
  if (st.status !== "sent" && st.status !== "delivered" && st.status !== "read") return null;

  const data: StatusWrite["data"] = {};
  const settling = UNSETTLED.has(job.status);
  if (settling) Object.assign(data, { status: "sent" as const, ...wamid, ...(job.sentAt ? {} : { sentAt: at }) });
  if ((st.status === "delivered" || st.status === "read") && !job.deliveredAt) data.deliveredAt = at;
  if (st.status === "read" && !job.readAt) data.readAt = at;
  if (Object.keys(data).length === 0) return null;
  return { data, guard: guardOf(data), settles: settling ? "sent" : null };
}
