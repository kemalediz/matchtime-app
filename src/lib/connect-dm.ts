/**
 * SELF-JOIN, SLICE 5: the connect DM handler (2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 2.2, 4.2,
 * 5.3, 5.4 and cap 6 of section 7. The rules are in connect-dm-rules.ts.
 *
 * Runs at the TOP of /api/whatsapp/dm-reply, only while SELF_JOIN_ENABLED
 * is on, before the bench reply, the sender lookup and every model path.
 * DETERMINISTIC: no model call anywhere in here.
 *
 * Returns null (the DM goes on to today's handling, untouched) when the
 * message carries no code or a code that names no connect request.
 * Otherwise the DM is this handler's, whatever it decides.
 *
 * What it writes:
 *   - the verification (`dm_verified`, `dmAt`, `dmPhone`, `dmLid`,
 *     `dmPhoneMatched`, `dmWaMessageId`, `addWindowEndsAt`), with a
 *     compare-and-set on `status = issued`. `dmLid` with `dmPhone` is the
 *     LID-to-phone pair slice 6 matches a LID-only group adder against;
 *   - `lastMismatchAt` / `lastMismatchPhoneMasked` for a code sent from
 *     another number (throttled, never answered);
 *   - `siteCapAt` when cap 6 was full;
 *   - a lazily noticed expiry.
 *
 * Replies go through the platform channel (`queuePlatformDm`, purpose
 * `connect-reply`), to the organiser's verified sign-up phone only, so they
 * share the Pi's one-DM-a-minute pacing, and ONCE per request per kind of
 * reply (refId `<connectId>:<kind>`), however often a DM is resent.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { londonMidnight } from "./club-connect-rules";
import {
  ADD_WINDOW_MS,
  decideConnectDm,
  effectiveConnectStatus,
  connectCodeCandidates,
  lidDigits,
  type ConnectDmReply,
} from "./connect-dm-rules";
import { PlatformDmRefused, platformPhoneDigits, queuePlatformDm } from "./platform-jobs";

export interface ConnectDmInput {
  text: string;
  /** The sender's phone as the Pi resolved it (JID, alt, local LID store). */
  phone?: string | null;
  /** The phone on the envelope's alt address, when there was one. */
  senderAltPhone?: string | null;
  /** The sender's LID, when the envelope carried one. */
  senderLid?: string | null;
  waMessageId: string;
  now?: Date;
}

export interface ConnectDmOutcome {
  handled: "connect-dm";
  result: string;
  replied: boolean;
}

/** Statuses whose code still points somewhere: preferred over a dead row
 *  that happens to share the code (codes are unique among live rows only). */
const LIVE = new Set(["issued", "dm_verified", "group_linked"]);

export async function handleConnectDm(input: ConnectDmInput): Promise<ConnectDmOutcome | null> {
  const candidates = connectCodeCandidates(input.text);
  if (candidates.length === 0) return null;
  const now = input.now ?? new Date();

  const rows = await db.clubConnect.findMany({
    where: { code: { in: candidates } },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      code: true,
      status: true,
      phone: true,
      issuedAt: true,
      expiresAt: true,
      addWindowEndsAt: true,
      dmLid: true,
      lastMismatchAt: true,
      userId: true,
      org: { select: { name: true, language: true, approvalStatus: true } },
    },
  });
  let row: (typeof rows)[number] | undefined;
  for (const code of candidates) {
    const forCode = rows.filter((r) => r.code === code);
    row = forCode.find((r) => LIVE.has(r.status)) ?? forCode[0];
    if (row) break;
  }
  if (!row) return null;

  const outcome = (result: string, replied = false): ConnectDmOutcome => {
    console.log(`[connect-dm] ${row.id} code=${row.code} result=${result} replied=${replied}`);
    return { handled: "connect-dm", result, replied };
  };

  // The same WhatsApp message forwarded twice (a Pi retry, a restart replay).
  if (await db.clubConnect.findUnique({ where: { dmWaMessageId: input.waMessageId }, select: { id: true } })) {
    return outcome("duplicate");
  }

  const phones: string[] = [];
  for (const raw of [input.phone, input.senderAltPhone]) {
    const d = typeof raw === "string" && raw.trim() ? platformPhoneDigits(raw) : null;
    if (d && !phones.includes(d)) phones.push(d);
  }
  const sender = { phones, lid: lidDigits(input.senderLid) };
  const ruleRow = {
    status: row.status,
    phone: row.phone,
    expiresAt: row.expiresAt,
    addWindowEndsAt: row.addWindowEndsAt,
    dmLid: row.dmLid,
    lastMismatchAt: row.lastMismatchAt,
    orgApprovalStatus: row.org.approvalStatus,
  };

  // Write down an expiry nobody has noticed yet, so the card agrees.
  if (effectiveConnectStatus(ruleRow, now) === "expired" && (row.status === "issued" || row.status === "dm_verified")) {
    await db.clubConnect.updateMany({ where: { id: row.id, status: row.status }, data: { status: "expired" } });
  }

  const first = decideConnectDm({ row: ruleRow, sender, now, linksToday: 0 });
  const lang = row.org.language;
  const connectId = row.id;
  const organiserPhone = row.phone;
  const organiserId = row.userId;
  const club = row.org.name;
  const reply = async (kind: ConnectDmReply) => {
    const organiser =
      kind === "connected" ? await db.user.findUnique({ where: { id: organiserId }, select: { name: true } }) : null;
    return queueConnectReply(connectId, organiserPhone, kind, connectReplyText(kind, lang, { name: organiser?.name ?? null, club }));
  };

  switch (first.action) {
    case "ignore":
      return outcome(first.reason);
    case "reply":
      return outcome(first.reply, await reply(first.reply));
    case "mismatch": {
      await db.clubConnect.updateMany({
        where: { id: row.id, status: "issued" },
        data: { lastMismatchAt: now, lastMismatchPhoneMasked: first.masked },
      });
      return outcome("mismatch");
    }
    case "site-cap":
    case "verify":
      break;
  }

  // Verify, under a site-wide lock so cap 6 cannot be overrun by two DMs at
  // once. The decision is taken again with the real count.
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"club-connect:links"}))`;
    const linksToday = await tx.clubConnect.count({ where: { dmAt: { gte: londonMidnight(now) } } });
    const d = decideConnectDm({ row: ruleRow, sender, now, linksToday });
    if (d.action === "site-cap") {
      await tx.clubConnect.updateMany({ where: { id: row.id, status: "issued" }, data: { siteCapAt: now } });
      return "site-cap" as const;
    }
    if (d.action !== "verify") return "race-lost" as const;
    const { count } = await tx.clubConnect.updateMany({
      where: { id: row.id, status: "issued" },
      data: {
        status: "dm_verified",
        dmAt: now,
        dmPhone: d.dmPhone,
        dmLid: sender.lid,
        dmPhoneMatched: d.dmPhoneMatched,
        dmWaMessageId: input.waMessageId,
        addWindowEndsAt: new Date(now.getTime() + ADD_WINDOW_MS),
        siteCapAt: null,
      },
    });
    return count === 1 ? ("verified" as const) : ("race-lost" as const);
  });

  if (result === "race-lost") return outcome("race-lost");
  if (result === "site-cap") return outcome("site-cap", await reply("site-cap"));
  if (sender.phones.length === 0) {
    console.warn(
      `[connect-dm] ${row.id} verified on the LID alone (lid ${sender.lid}); the organiser's WhatsApp number is not confirmed`,
    );
  }
  return outcome("verified", await reply("connected"));
}

/** The reply's text, in the club's language (plan 5.3, 5.4). */
export function connectReplyText(
  kind: ConnectDmReply,
  lang: string | null | undefined,
  p: { name: string | null; club: string },
): string {
  const s = t(lang);
  switch (kind) {
    case "connected":
      return s.sj_dm_connected({ name: firstName(p.name), club: p.club });
    case "already-connected":
      return s.sj_dm_already_connected;
    case "expired":
      return s.sj_dm_code_expired;
    case "site-cap":
      return s.sj_site_cap_groups;
  }
}

function firstName(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Queue one reply of this kind for this request, ever. True when queued. */
async function queueConnectReply(connectId: string, phone: string, kind: ConnectDmReply, text: string): Promise<boolean> {
  const refId = `${connectId}:${kind}`;
  const already = await db.platformJob.findFirst({ where: { purpose: "connect-reply", refId }, select: { id: true } });
  if (already) return false;
  try {
    await queuePlatformDm({ phone, text, purpose: "connect-reply", refId });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[connect-dm] reply ${refId} not queued: ${err.reason}`);
      return false;
    }
    throw err;
  }
}
