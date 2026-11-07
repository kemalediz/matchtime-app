/**
 * META'S WEBHOOK, READ (WhatsApp Cloud API plan, PR C5; MDs/whatsapp-cloud-
 * api-plan-2026-11-04.md sections 1, 5.2, 5.3 and 5.4). Pure: a payload
 * in, what arrived out. No database, no network, no clock. Never throws.
 *
 * One POST carries up to 1,000 updates as `entry[].changes[]`, each with a
 * `field` and a `value`:
 *   messages                  `value.messages[]` (what people wrote to the
 *                             official number) and `value.statuses[]`
 *                             (sent, delivered, read, failed for what we
 *                             sent), with `value.contacts[]` naming the
 *                             senders and `value.metadata` our number.
 *   message_template_status_update, template_category_update
 *                             counted here; C6's `applyTemplateStatusPayload`
 *                             reads them from the whole payload.
 *   user_preferences          he stopped or resumed marketing messages.
 *   anything else             named, for the log.
 *
 * WHO WROTE (plan 5.4). `from` is his phone, digits; a person with a
 * WhatsApp username may arrive with no phone, named only by the business
 * scoped user id (`from_user_id`, `contacts[].user_id`). Either one is
 * enough; a message naming neither is skipped (WaInbound's CHECK needs
 * one). A phone that is not 8 to 15 digits is no phone.
 *
 * WHAT HE WROTE. The text the one DM pipeline reads: `text.body`, a
 * template quick reply's `button.text`, an interactive reply's title, or
 * a media caption (the Pi forwards a caption as the DM's body too).
 * Anything else (a reaction, a sticker, media with no caption) has no text:
 * it is still recorded, since any message opens his 24 hour window.
 *
 * Meta retries for up to 7 days and repeats updates; a repeat INSIDE one
 * POST is dropped here, and the database keys catch the rest.
 */
import type { InboundDm } from "../inbound-dm";

export interface CloudInboundMessage {
  wamid: string;
  /** Our number it arrived on (`metadata.phone_number_id`). */
  phoneNumberId: string | null;
  /** His phone, digits, no "+". Null for a username with no phone. */
  phone: string | null;
  /** Meta's business scoped user id. */
  waUserId: string | null;
  type: string;
  /** What the pipeline reads; null when there is nothing to read. */
  text: string | null;
  senderName: string | null;
  /** Unix seconds, as Meta sends it. */
  timestamp: string | null;
  /** A swipe-reply: the quoted wamid, and whether it was our message. */
  quotedId: string | null;
  quotedFromUs: boolean | null;
}

export interface CloudStatusUpdate {
  wamid: string;
  phoneNumberId: string | null;
  /** sent | delivered | read | failed (Meta may add others). */
  status: string;
  at: Date | null;
  recipient: string | null;
  recipientUserId: string | null;
  /** `biz_opaque_callback_data`: the PlatformJob id the client set. */
  jobId: string | null;
  errorCode: number | null;
  errorTitle: string | null;
  pricing: { category: string | null; billable: boolean | null; model: string | null; type: string | null } | null;
}

export interface CloudUserPreference {
  phone: string | null;
  waUserId: string | null;
  category: string | null;
  /** "stop" | "resume" */
  value: string | null;
  at: Date | null;
}

export interface ParsedCloudWebhook {
  messages: CloudInboundMessage[];
  statuses: CloudStatusUpdate[];
  preferences: CloudUserPreference[];
  /** Template status and category changes seen (C6 writes them). */
  templateUpdates: number;
  /** Fields with no reader yet (quality, account updates), for the log. */
  otherFields: string[];
  /** Messages and statuses dropped as unreadable. */
  skipped: number;
}

const TEMPLATE_FIELDS = new Set(["message_template_status_update", "template_category_update"]);
const PHONE_RE = /^[0-9]{8,15}$/;
const CAPTIONED = ["image", "video", "document"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const phoneOf = (v: unknown): string | null => {
  const s = str(v);
  return s && PHONE_RE.test(s) ? s : null;
};

function timeOf(v: unknown): Date | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** The words of one message, or null when it has none. */
function textOf(m: Obj, type: string): string | null {
  const field = (key: string, inner: string) => (isObj(m[key]) ? str((m[key] as Obj)[inner]) : null);
  if (type === "text") return field("text", "body");
  if (type === "button") return field("button", "text");
  if (type === "interactive" && isObj(m.interactive)) {
    const i = m.interactive;
    return (isObj(i.button_reply) ? str(i.button_reply.title) : null) ?? (isObj(i.list_reply) ? str(i.list_reply.title) : null);
  }
  if (CAPTIONED.includes(type)) return field(type, "caption");
  return null;
}

function readMessage(m: Obj, value: Obj, contacts: Obj[]): CloudInboundMessage | null {
  const wamid = str(m.id);
  if (!wamid) return null;
  const phone = phoneOf(m.from);
  const contact =
    contacts.find((c) => (phone && str(c.wa_id) === phone) || (str(m.from_user_id) && str(c.user_id) === str(m.from_user_id))) ??
    (contacts.length === 1 ? contacts[0] : undefined);
  const waUserId = str(m.from_user_id) ?? (contact ? str(contact.user_id) : null);
  if (!phone && !waUserId) return null;
  const type = str(m.type) ?? "unknown";
  const ctx = isObj(m.context) ? m.context : null;
  const quotedId = ctx ? str(ctx.id) : null;
  const ours = isObj(value.metadata) ? str(value.metadata.display_phone_number)?.replace(/\D/g, "") : null;
  const quotedFrom = ctx ? str(ctx.from)?.replace(/\D/g, "") : null;
  return {
    wamid,
    phoneNumberId: isObj(value.metadata) ? str(value.metadata.phone_number_id) : null,
    phone,
    waUserId,
    type,
    text: textOf(m, type),
    senderName: contact && isObj(contact.profile) ? str(contact.profile.name) : null,
    timestamp: typeof m.timestamp === "string" || typeof m.timestamp === "number" ? String(m.timestamp) : null,
    quotedId,
    quotedFromUs: quotedId ? !!ours && quotedFrom === ours : null,
  };
}

function readStatus(s: Obj, value: Obj): CloudStatusUpdate | null {
  const wamid = str(s.id);
  const status = str(s.status);
  if (!wamid || !status) return null;
  const err = isObj(list(s.errors)[0]) ? (list(s.errors)[0] as Obj) : null;
  const p = isObj(s.pricing) ? s.pricing : null;
  return {
    wamid,
    phoneNumberId: isObj(value.metadata) ? str(value.metadata.phone_number_id) : null,
    status,
    at: timeOf(s.timestamp),
    recipient: phoneOf(s.recipient_id),
    recipientUserId: str(s.recipient_user_id),
    jobId: str(s.biz_opaque_callback_data),
    errorCode: err && typeof err.code === "number" ? err.code : null,
    errorTitle: err ? (str(err.title) ?? str(err.message)) : null,
    pricing: p
      ? { category: str(p.category), billable: typeof p.billable === "boolean" ? p.billable : null, model: str(p.pricing_model), type: str(p.type) }
      : null,
  };
}

export function parseCloudWebhook(payload: unknown): ParsedCloudWebhook {
  const out: ParsedCloudWebhook = { messages: [], statuses: [], preferences: [], templateUpdates: 0, otherFields: [], skipped: 0 };
  if (!isObj(payload)) return out;
  const seenMessages = new Set<string>();
  const seenStatuses = new Set<string>();
  for (const entry of list(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of list(entry.changes)) {
      if (!isObj(change)) continue;
      const field = str(change.field);
      const value = isObj(change.value) ? change.value : null;
      if (!field || !value) continue;
      if (TEMPLATE_FIELDS.has(field)) {
        out.templateUpdates++;
        continue;
      }
      if (field === "user_preferences") {
        for (const u of list(value.user_preferences)) {
          if (!isObj(u)) continue;
          out.preferences.push({ phone: phoneOf(u.wa_id), waUserId: str(u.user_id), category: str(u.category), value: str(u.value), at: timeOf(u.timestamp) });
        }
        continue;
      }
      if (field !== "messages") {
        out.otherFields.push(field);
        continue;
      }
      const contacts = list(value.contacts).filter(isObj);
      for (const m of list(value.messages)) {
        const msg = isObj(m) ? readMessage(m, value, contacts) : null;
        if (!msg) {
          out.skipped++;
          continue;
        }
        if (seenMessages.has(msg.wamid)) continue;
        seenMessages.add(msg.wamid);
        out.messages.push(msg);
      }
      for (const s of list(value.statuses)) {
        const st = isObj(s) ? readStatus(s, value) : null;
        if (!st) {
          out.skipped++;
          continue;
        }
        const key = `${st.wamid}\u0000${st.status}`;
        if (seenStatuses.has(key)) continue;
        seenStatuses.add(key);
        out.statuses.push(st);
      }
    }
  }
  return out;
}

/** The one DM pipeline's input (plan 5.3): the same shape the Pi posts to
 *  dm-reply. Null for a message with nothing to read. A username with no
 *  phone goes in with none, handled as an unknown sender (plan 5.4). Meta
 *  sends no quoted text, only the quoted id. */
export function inboundDmOf(m: CloudInboundMessage): InboundDm | null {
  if (!m.text) return null;
  return {
    ...(m.phone ? { phone: m.phone } : {}),
    body: m.text,
    waMessageId: m.wamid,
    ...(m.senderName ? { authorName: m.senderName } : {}),
    ...(m.timestamp ? { timestamp: m.timestamp } : {}),
    ...(m.quotedId ? { quotedMessageId: m.quotedId, quotedFromMatchTime: m.quotedFromUs === true } : {}),
  };
}
