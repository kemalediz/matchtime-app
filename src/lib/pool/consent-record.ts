/**
 * THE CONSENT RECORD (slice L2): the one writer of `PoolConsentRecord`,
 * append-only. Every agreement (the WhatsApp confirm, "start again" on the
 * manage page) and every withdrawal (stop, delete) adds a row; nothing
 * updates or deletes one with the profile or the User (no foreign key).
 * Kept POOL_RETENTION.consentRecordYears, as the privacy policy says.
 */
import { db } from "../db";
import type { PoolConsentAction, PoolConsentChannel } from "./vocab";

type Client = Parameters<Parameters<typeof db.$transaction>[0]>[0] | typeof db;

export async function recordPoolConsent(
  client: Client,
  r: { userId: string; action: PoolConsentAction; channel: PoolConsentChannel; evidence: string; version?: number | null; phone?: string | null; code?: string | null; at?: Date },
): Promise<void> {
  await client.poolConsentRecord.create({
    data: {
      userId: r.userId,
      action: r.action,
      channel: r.channel,
      evidence: r.evidence,
      version: r.version ?? null,
      phone: r.phone ?? null,
      code: r.code ?? null,
      ...(r.at ? { createdAt: r.at } : {}),
    },
  });
}
