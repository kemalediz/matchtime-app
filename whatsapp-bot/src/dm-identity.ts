/**
 * Self-join slice 5: the two identities a DM forward adds for the connect
 * DM (plan MDs/self-join-and-approval-plan-2026-09-28.md, 2.2 and 5.3).
 *
 *   senderLid       the sender's WhatsApp LID, bare digits. The server
 *                   stores it with the organiser's phone on the connect
 *                   request, so the later group add can match a LID-only
 *                   adder (slice 6).
 *   senderAltPhone  the phone on the envelope's alternate address, when a
 *                   LID-addressed DM carried one.
 *
 * Read off the chat id and the contact record the driver already built
 * from the envelope and its local store. NEVER a directory lookup
 * (`drivers/baileys.source.test.ts` bans those). Total: every read is
 * guarded, so a broken whatsapp-web.js build's throwing getters cost the
 * extras, never the forward. An absent field is exactly what a Pi built
 * before slice 5 sends, and the server handles both.
 */
import { asString, safePath, safeRead } from "./wa-read.js";

export interface DmSenderExtras {
  senderLid?: string;
  senderAltPhone?: string;
}

const LID_JID = /^(\d{6,20})(?::\d+)?@lid$/;

function lidOf(v: unknown): string | null {
  const s = asString(v).trim();
  if (/^\d{6,20}$/.test(s)) return s;
  const m = LID_JID.exec(s);
  return m ? m[1] : null;
}

export function dmSenderExtras(from: string, contact: unknown): DmSenderExtras {
  const out: DmSenderExtras = {};
  const lid =
    (LID_JID.test(from) ? lidOf(from) : null) ??
    lidOf(safeRead(contact, "lid")) ??
    (LID_JID.test(asString(safePath(contact, "id", "_serialized"))) ? lidOf(safePath(contact, "id", "_serialized")) : null);
  if (lid) out.senderLid = lid;
  const alt = asString(safeRead(contact, "altPhone")).replace(/\D/g, "");
  if (/^\d{8,15}$/.test(alt)) out.senderAltPhone = alt;
  return out;
}
