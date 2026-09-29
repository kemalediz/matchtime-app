/**
 * SELF-JOIN, SLICE 4: connect codes and the MatchTime number, server
 * side. Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections
 * 3.2, 4.2, 5.2 and cap 5 of section 7.
 *
 * ── THE NUMBER IS SERVER-ONLY ──────────────────────────────────────────
 * `MATCHTIME_WA_NUMBER` is read HERE and nowhere else, never through a
 * `NEXT_PUBLIC_` name, and no client component imports this file
 * (`__tests__/wa-number-server-only.test.ts`). The number is rendered
 * only inside the signed-in organiser's own club page, after the club
 * exists (the status card and the wa.me link). Signed-out pages, the
 * sitemap and every JS bundle never carry it
 * (`e2e/web/self-join-organiser.spec.ts`).
 *
 * ── CODES ──────────────────────────────────────────────────────────────
 * One live code per club (a second tap reuses it), 60 minutes each, 3
 * issued per club per London day. Stale rows are expired lazily here,
 * before the count, so the card and the cap never read a dead code as
 * live. Issuing is serialised per club with a transaction-scoped
 * advisory lock (the same tool team-slot-fill.ts uses), so two taps at
 * once cannot leave two live codes.
 */
import { db } from "./db";
import { normalisePhone } from "./phone";
import {
  CONNECT_CODE_TTL_MS,
  MAX_CODES_PER_CLUB_PER_DAY,
  generateConnectCode,
  londonMidnight,
  type ConnectRow,
} from "./club-connect-rules";

/** The MatchTime WhatsApp number, digits only, or null when not set. */
export function matchtimeWaNumber(env: Record<string, string | undefined> = process.env): string | null {
  const digits = (env.MATCHTIME_WA_NUMBER ?? "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** Statuses whose code still points at something: a new code must not
 *  collide with any of them. */
const LIVE_CODE_STATUSES = ["issued", "dm_verified", "group_linked"];

export type IssueResult =
  | { ok: true; code: string; reused: boolean }
  | { ok: false; reason: "not-draft" | "no-phone" | "already-connected" | "code-cap" };

export async function issueConnectCode(args: {
  orgId: string;
  userId: string;
  phone: string | null;
  now: Date;
}): Promise<IssueResult> {
  const { orgId, userId, now } = args;
  const e164 = normalisePhone(args.phone);
  if (!e164) return { ok: false, reason: "no-phone" };
  const digits = e164.slice(1);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`club-connect:${orgId}`}))`;

    const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { approvalStatus: true } });
    if (!org || org.approvalStatus !== "draft") return { ok: false, reason: "not-draft" } as const;

    await tx.clubConnect.updateMany({
      where: { orgId, status: "issued", expiresAt: { lte: now } },
      data: { status: "expired" },
    });
    await tx.clubConnect.updateMany({
      where: { orgId, status: "dm_verified", addWindowEndsAt: { lte: now } },
      data: { status: "expired" },
    });

    const live = await tx.clubConnect.findFirst({
      where: { orgId, status: { in: ["issued", "dm_verified"] } },
      orderBy: { issuedAt: "desc" },
      select: { status: true, code: true },
    });
    if (live?.status === "dm_verified") return { ok: false, reason: "already-connected" } as const;
    if (live) return { ok: true, code: live.code, reused: true } as const;

    const today = await tx.clubConnect.count({ where: { orgId, issuedAt: { gte: londonMidnight(now) } } });
    if (today >= MAX_CODES_PER_CLUB_PER_DAY) return { ok: false, reason: "code-cap" } as const;

    let code = generateConnectCode();
    for (let i = 0; i < 20; i++) {
      const clash = await tx.clubConnect.count({ where: { code, status: { in: LIVE_CODE_STATUSES } } });
      if (clash === 0) break;
      code = generateConnectCode();
    }

    await tx.clubConnect.create({
      data: {
        orgId,
        userId,
        phone: digits,
        code,
        status: "issued",
        issuedAt: now,
        expiresAt: new Date(now.getTime() + CONNECT_CODE_TTL_MS),
      },
    });
    return { ok: true, code, reused: false } as const;
  });
}

/** The club's most recent connect request, as the status card reads it. */
export async function loadLatestConnect(orgId: string): Promise<ConnectRow | null> {
  return db.clubConnect.findFirst({
    where: { orgId },
    orderBy: { issuedAt: "desc" },
    select: {
      status: true,
      code: true,
      expiresAt: true,
      addWindowEndsAt: true,
      lastMismatchAt: true,
      lastMismatchPhoneMasked: true,
      groupSubject: true,
      adderMatch: true,
      siteCapAt: true,
    },
  });
}
