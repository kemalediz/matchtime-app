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
 * (`e2e/web/self-join-organiser.spec.ts`). The official Cloud API number
 * `WA_CLOUD_NUMBER` follows the same rule and is read here too
 * (`waNumberFor`, WhatsApp Cloud API plan PR C1).
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
import type { SendChannel } from "./send-channel";

const digitsOrNull = (value: string | undefined): string | null => {
  const digits = (value ?? "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
};

/** The MatchTime WhatsApp number, digits only, or null when not set. */
export function matchtimeWaNumber(env: Record<string, string | undefined> = process.env): string | null {
  return digitsOrNull(env.MATCHTIME_WA_NUMBER);
}

/**
 * The number for a channel `send-channel.ts` decided (Cloud API plan, PR
 * C1, section 5.1): "baileys" is the club number above, "cloud" the
 * official number `WA_CLOUD_NUMBER`, read here so the server only rule
 * covers both (`wa-number-server-only.test.ts`). An unset or invalid
 * official number is null, never the club number: a stranger is never
 * silently put back on the club number.
 */
export function waNumberFor(channel: SendChannel, env: Record<string, string | undefined> = process.env): string | null {
  return channel === "cloud" ? digitsOrNull(env.WA_CLOUD_NUMBER) : matchtimeWaNumber(env);
}

/**
 * The number the code pages (/login, /signup, /claim) may name after a
 * code was queued (Cloud API plan, PR C7a, section 3.1): the official
 * number, "+<digits>", when the code goes from it, since it is new to the
 * person and its message is the one to look for. The club number is NEVER
 * named here: it stays off signed-out pages (the rule above). Null when
 * nothing is to be named. Called only by src/lib/code-dm.ts
 * (`send-channel-source-guard.test.ts`).
 */
export function codeSenderNumber(channel: SendChannel, env: Record<string, string | undefined> = process.env): string | null {
  if (channel !== "cloud") return null;
  const digits = waNumberFor(channel, env);
  return digits ? `+${digits}` : null;
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
