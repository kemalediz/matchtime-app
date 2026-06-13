/**
 * Pure helpers for WhatsApp participant snapshots (no db import — unit
 * testable, shared by the sync route lib and the bot-added route).
 */
import { normalisePhone } from "./phone";

export interface SnapshotParticipant {
  phone?: string | null;
  lidId?: string | null;
  pushname?: string | null;
}

/**
 * Canonicalise a snapshot participant's phone. The bot strips the
 * leading "+" from JID-derived phones ("447989747424"); normalisePhone
 * preserves no-+ input as-is, so prepend before normalising — without
 * this every WA participant looks like a NEW user because "447xxx"
 * never matches stored "+447xxx".
 */
export function snapshotPhone(p: SnapshotParticipant): string | null {
  if (!p.phone) return null;
  const rawWithPlus = p.phone.startsWith("+") ? p.phone : `+${p.phone}`;
  return normalisePhone(rawWithPlus);
}

/**
 * Normalise an untrusted snapshot (e.g. the Json column on
 * OnboardingSession, or a bot-POSTed body) into a clean
 * SnapshotParticipant[]. Non-arrays and junk entries collapse to [].
 */
export function parseParticipantSnapshot(raw: unknown): SnapshotParticipant[] {
  if (!Array.isArray(raw)) return [];
  const out: SnapshotParticipant[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const phone = typeof o.phone === "string" && o.phone.trim() ? o.phone.trim() : null;
    const lidId = typeof o.lidId === "string" && o.lidId.trim() ? o.lidId.trim() : null;
    const pushname =
      typeof o.pushname === "string" && o.pushname.trim() ? o.pushname.trim() : null;
    if (!phone && !lidId && !pushname) continue;
    out.push({ phone, lidId, pushname });
  }
  return out;
}
