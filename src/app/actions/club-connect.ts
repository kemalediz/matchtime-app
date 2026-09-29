"use server";

/**
 * Self-join slice 4: the "Add MatchTime to WhatsApp" button
 * (plan section 5.2). For the club's OWNER only, only with
 * SELF_JOIN_ENABLED on, only while the club is a draft.
 *
 * The answer carries the MatchTime number inside the wa.me link. That is
 * the one response that may: it goes to the signed-in owner of a club
 * that already exists, which is exactly where the number is allowed.
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { t } from "@/lib/i18n/t";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";
import { issueConnectCode, matchtimeWaNumber } from "@/lib/club-connect";
import { connectPrefill, waMeLink } from "@/lib/club-connect-rules";
import { revalidatePath } from "next/cache";

export type StartClubConnectResult =
  | { ok: true; href: string; code: string }
  | {
      ok: false;
      reason: "off" | "signed-out" | "not-owner" | "no-number" | "not-draft" | "no-phone" | "already-connected" | "code-cap";
      error: string;
    };

export async function startClubConnect(orgId: string): Promise<StartClubConnectResult> {
  const session = await auth();
  const userId = session?.user?.id;
  const fallback = t("en").sj_err_generic;
  if (!userId) return { ok: false, reason: "signed-out", error: fallback };
  if (!(await selfJoinEnabledForRequest())) return { ok: false, reason: "off", error: fallback };

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { role: true, leftAt: true },
  });
  if (!membership || membership.leftAt !== null || membership.role !== "OWNER") {
    return { ok: false, reason: "not-owner", error: fallback };
  }

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, language: true },
  });
  if (!org) return { ok: false, reason: "not-owner", error: fallback };
  const s = t(org.language);

  const number = matchtimeWaNumber();
  if (!number) return { ok: false, reason: "no-number", error: s.sj_card_unavailable };

  const user = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });
  const res = await issueConnectCode({ orgId, userId, phone: user?.phoneNumber ?? null, now: new Date() });
  if (!res.ok) {
    const error = {
      "not-draft": s.sj_err_generic,
      "no-phone": s.sj_err_verify_phone,
      "already-connected": s.sj_card_already_connected,
      "code-cap": s.sj_card_code_cap,
    }[res.reason];
    return { ok: false, reason: res.reason, error };
  }

  revalidatePath("/admin");
  return { ok: true, href: waMeLink(number, connectPrefill(org.language, org.name, res.code)), code: res.code };
}
