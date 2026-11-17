/**
 * A SHARED WHATSAPP CONTACT CARD, READ AS A FILE (2026-11-17). Pure.
 *
 * WhatsApp sends a shared contact as a vCard (RFC 6350), which the Pi
 * forwards as the message's text (`whatsapp-bot/src/baileys/inbound.ts`,
 * type "vcard"). This module reads that CONTAINER: the display name (`FN`,
 * else `N`) and the phone number (`TEL`, preferring the `waid` WhatsApp
 * puts on the number the person uses WhatsApp with). It never reads
 * anything a person typed: a message is a card only when it IS a vCard
 * (`BEGIN:VCARD` first), never because its words mention one. That is the
 * same envelope test `attendance-engine-batch.ts` uses to refuse a card as
 * an attendance message (the 2026-06-11 "Salman Shelly Ftbl" incident),
 * and it is why the name read here is a phone-book LABEL, cleaned only by
 * `rules.ts` `cleanCardName` and never trusted over a name the organiser
 * writes.
 */
import { e164Digits, normalisePhone } from "../phone";

export interface ContactCard {
  /** The card's display name as saved in the sender's phone, or null. */
  name: string | null;
  /** E.164 ("+447700900123"), or null when the card has no usable number. */
  phone: string | null;
}

const BEGIN = /^BEGIN:VCARD\b/i;

/** The message is a contact card: its first line opens a vCard. */
export function isContactCard(text: string | null | undefined): boolean {
  return typeof text === "string" && BEGIN.test(text.trimStart());
}

/** vCard text escapes: "\," "\;" "\\" "\n". */
function unescape(v: string): string {
  return v.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ").trim();
}

/** One property line, split into its name (no group prefix), its params and its value. */
function property(line: string): { name: string; params: string[]; value: string } | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const [head, ...params] = line.slice(0, colon).split(";");
  const name = head.slice(head.lastIndexOf(".") + 1).toUpperCase();
  return { name, params, value: line.slice(colon + 1) };
}

function phoneOf(params: string[], value: string): { phone: string | null; whatsapp: boolean } {
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq > 0 && p.slice(0, eq).trim().toLowerCase() === "waid") {
      const digits = e164Digits(p.slice(eq + 1).trim());
      if (digits) return { phone: `+${digits}`, whatsapp: true };
    }
  }
  const direct = normalisePhone(value.trim());
  if (direct) return { phone: direct, whatsapp: false };
  const digits = e164Digits(value.trim());
  return { phone: digits ? `+${digits}` : null, whatsapp: false };
}

function readOne(block: string): ContactCard {
  let fn: string | null = null;
  let n: string | null = null;
  let firstPhone: string | null = null;
  let waPhone: string | null = null;
  for (const line of block.split("\n")) {
    const p = property(line.trim());
    if (!p) continue;
    if (p.name === "FN" && !fn) fn = unescape(p.value) || null;
    else if (p.name === "N" && !n) {
      const [family = "", given = ""] = p.value.split(";").map(unescape);
      n = [given, family].filter(Boolean).join(" ").trim() || null;
    } else if (p.name === "TEL") {
      const t = phoneOf(p.params, p.value);
      if (t.whatsapp && !waPhone) waPhone = t.phone;
      if (t.phone && !firstPhone) firstPhone = t.phone;
    }
  }
  return { name: fn ?? n, phone: waPhone ?? firstPhone };
}

/**
 * Every card in a message (WhatsApp can share several at once), in order.
 * Empty when the message is not a card. Folded lines are unfolded first.
 */
export function readContactCards(text: string | null | undefined): ContactCard[] {
  if (!isContactCard(text)) return [];
  const unfolded = (text as string).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of unfolded.split("\n")) {
    if (BEGIN.test(line.trim())) {
      if (current) blocks.push(current.join("\n"));
      current = [];
    } else if (/^END:VCARD\b/i.test(line.trim())) {
      if (current) blocks.push(current.join("\n"));
      current = null;
    } else if (current) current.push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return blocks.map(readOne);
}

/**
 * What a card is replaced by wherever its text would otherwise be shown or
 * stored (the HQ log, the players' group history the models read): no
 * name, no number. A card's number must never reach a model's context,
 * where an answer could repeat it in a group.
 */
export const CONTACT_CARD_LABEL = "[shared a contact card]";

/** A message's text as it may be stored or shown to a model: a card is
 *  replaced by its label, anything else is unchanged. */
export function cardSafeText(text: string): string {
  return isContactCard(text) ? CONTACT_CARD_LABEL : text;
}

/**
 * A history list the Pi forwards (the join-history bundle), with every
 * line that is a contact card left out (2026-11-17). A card in a group's
 * past chat is nobody's request; its name and number must not be stored.
 * Anything that is not a list is returned as it came.
 */
export function withoutContactCards(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((r) => {
    if (!r || typeof r !== "object") return true;
    const t = (r as { text?: unknown; body?: unknown }).text ?? (r as { body?: unknown }).body;
    return !(typeof t === "string" && isContactCard(t));
  });
}
