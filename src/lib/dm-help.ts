/**
 * "help" by DM (2026-09-30): the same help as the group.
 *
 * Kemal DMed MatchTime "help payments" after the first real self-setup;
 * DM help did not exist. This answers it with `buildHelpReply`, the SAME
 * builder the group's "@Match Time help" uses, so the two can never
 * disagree.
 *
 * READ BY THE MODEL (2026-10-28). Whether a DM asks for help, and about
 * what, is the shared question extractor's `how_it_works` and its topic
 * (`readDmHelp`), the reader the players' group and the admin group use.
 * The regex reader (`readHelpRequest`: the keyword plus a known topic word
 * in at most four words) is gone, so "how do I turn on the player pool?"
 * and "havuz nasıl açılır" are help too. One extractor call, made where
 * the DM reaches the scoped Q&A (dm-reply/route.ts), behind every handler
 * that knows which question is being answered, and under the club's daily
 * AI cap.
 *
 * WHICH CLUB. A DM has no group, so the club is the sender's:
 *   - one active club: that one;
 *   - several: the club they RUN (OWNER/ADMIN) when they run exactly one,
 *     because a help question from an organiser is almost always about
 *     their own club; otherwise the club with the most recent match among
 *     the ones they run, or among all of them when they run none (the
 *     same rule `pickRelevantOrgForUser` uses for DM questions). With more
 *     than one club the reply names the club on its first line, so an
 *     answer about the "wrong" club is at least never a silent one.
 * Only approved clubs count: an organiser whose club is waiting for
 * approval is silenced upstream, and a draft club is nobody's answer.
 *
 * WHO. The club's OWNER/ADMIN gets the admin lines (where its settings
 * live, how to switch a feature on) with links that sign them straight
 * in; everybody else gets the player-facing text and no link.
 *
 * WHERE THE REPLY GOES. To the number the DM came from. A signed-in link
 * is only minted when that number IS the account's own phone: a sender
 * resolved any other way gets public URLs, never a credential.
 *
 * WHICH CHANNEL. The club's own (a BotJob), except for a club that is
 * approved but still setting up: its channel is not dispatched until its
 * organiser says GO, so the caller asks for `deliver: "platform"` and the
 * answer goes out on the platform channel (go-live slice S4).
 */
import { db } from "@/lib/db";
import { REPLY_PRIORITY } from "@/lib/dm-reply-priority";
import { normalisePhone } from "@/lib/phone";
import { getOrgFeatures } from "@/lib/org-features";
import { buildAdminLink } from "@/lib/admin-link";
import { APPROVED_CLUB_WHERE } from "@/lib/club-approval-state";
import { SETUP_STAGE_SELECT, preferLiveClubs } from "@/lib/club-setup-rules";
import { t } from "@/lib/i18n/t";
import { queuePlatformDm } from "@/lib/platform-jobs";
import { helpAdminPagePath, helpPagesNeeded, type HelpAdminPage, type HelpAudience, type HelpTopic } from "@/lib/onboarding-conversation";
import { clubHelpReply } from "@/lib/help-answer";
import { extractForRoute } from "@/lib/pipeline/extractors";
import { extractorStubFromEnv } from "@/lib/pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "@/lib/pipeline/llm";
import { playersHelpTopic, type HelpRequest } from "@/lib/pipeline/types";
import { hasFeeToSettle, type MyPayments } from "@/lib/my-payments-rules";
import { readMyPayments } from "@/lib/my-payments";

type Env = Record<string, string | undefined>;

/**
 * Does this DM ask for help, and about what? The shared question
 * extractor reads it as the players' group's would (a DM is addressed to
 * MatchTime, so `tagged`). Null for anything else, and when the call fails
 * or the cap refuses it: the DM then carries on to the handlers below, as
 * any other DM does.
 */
export async function readDmHelp(args: {
  text: string;
  authorName: string | null;
  now: Date;
  model?: PipelineModel;
}): Promise<HelpRequest | null> {
  const body = args.text.trim();
  if (!body) return null;
  try {
    const model = args.model ?? extractorStubFromEnv() ?? anthropicModel();
    const r = await extractForRoute(model, "question", {
      id: "dm",
      body,
      authorName: args.authorName,
      tagged: true,
      history: [],
      lastBotPost: null,
      now: args.now,
    });
    const f = r.facts;
    if (f.kind !== "question" || f.topic !== "how_it_works") return null;
    return { topic: f.feature ?? null, ...(f.feature === "badges" && f.badge ? { badge: f.badge } : {}) };
  } catch (err) {
    console.error("[dm-help] help read failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}

/**
 * Does the help give way to the DM Q&A (2026-11-04)? "How do I pay?" is
 * help about payments, and the help explains how fees work, with no link.
 * For a player with a fee of his own still open that is the wrong answer:
 * he is asking how to pay THAT, and the DM Q&A has his fee and his pay
 * link (`my-payments-rules.ts`). The facts decide, never his words: help
 * about payments, and he has a fee to settle.
 */
export function helpGivesWayToOwnFee(req: HelpRequest, payments: MyPayments | null): boolean {
  return req.topic === "payments" && !!payments && hasFeeToSettle(payments);
}

/** `helpGivesWayToOwnFee` against his payments in the club the DM Q&A
 *  would answer for. Reads them only for help about payments, mints no pay
 *  link, and a failed read leaves the answer to the help. */
export async function helpGivesWayForOwnFee(req: HelpRequest, args: { userId: string; orgId: string }): Promise<boolean> {
  if (req.topic !== "payments") return false;
  const payments = await readMyPayments({ orgId: args.orgId, userId: args.userId, upcomingFee: null }).catch((err) => {
    console.error(`[dm-help] own payments read failed for org=${args.orgId}; the help answers:`, err);
    return null;
  });
  return helpGivesWayToOwnFee(req, payments);
}

type HelpMembership = {
  orgId: string;
  role: "OWNER" | "ADMIN" | "PLAYER";
  org: { id: string; name: string; language: string };
};

const runs = (m: HelpMembership) => m.role === "OWNER" || m.role === "ADMIN";

/** The club a DM help question is answered for. See the header. */
export async function pickDmHelpClub(
  userId: string,
): Promise<{ membership: HelpMembership; clubCount: number } | null> {
  // A club that is still setting up is left out when the person has a live
  // club too (club-setup.ts). Someone whose ONLY club is setting up keeps
  // it: the help is theirs to ask for.
  const memberships = preferLiveClubs(
    (await db.membership.findMany({
      where: { userId, leftAt: null, org: APPROVED_CLUB_WHERE },
      select: { orgId: true, role: true, org: { select: { id: true, name: true, language: true, ...SETUP_STAGE_SELECT } } },
      orderBy: { createdAt: "asc" },
    })) as Array<HelpMembership & { org: { approvalStatus: string } }>,
    (m) => m.org,
  ) as HelpMembership[];
  if (memberships.length === 0) return null;
  if (memberships.length === 1) return { membership: memberships[0], clubCount: 1 };
  const admin = memberships.filter(runs);
  if (admin.length === 1) return { membership: admin[0], clubCount: memberships.length };
  const pool = admin.length > 1 ? admin : memberships;
  const recent = await db.match.findFirst({
    where: { activity: { orgId: { in: pool.map((m) => m.orgId) } } },
    orderBy: { date: "desc" },
    select: { activity: { select: { orgId: true } } },
  });
  const pick = pool.find((m) => m.orgId === recent?.activity.orgId) ?? pool[0];
  return { membership: pick, clubCount: memberships.length };
}

export type DmHelpOutcome = {
  handled: "dm-help";
  topic: HelpTopic | null;
  orgId: string;
  audience: HelpAudience;
};

/**
 * Answer a DM that is a help request. Returns null when the DM is not one
 * (or there is no club or no number to answer), and the caller carries on
 * down its handler list.
 */
export async function handleDmHelp(args: {
  userId: string;
  /** What the DM asks for, as `readDmHelp` read it. */
  req: HelpRequest;
  /** Resolves the pool switch as the request does. */
  poolEnv?: () => Promise<Env>;
  /** The number the DM came from, in any format; "" when unknown. */
  envelopePhone: string | null | undefined;
  /** "platform": the club is setting up and its own channel is off, so
   *  the answer goes out on the platform channel. Default "club". Throws
   *  `PlatformDmRefused` if that channel refuses the number. */
  deliver?: "club" | "platform";
}): Promise<DmHelpOutcome | null> {
  const req = args.req;
  const picked = await pickDmHelpClub(args.userId);
  if (!picked) return null;
  const { membership, clubCount } = picked;

  const account = await db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } });
  const accountPhone = account?.phoneNumber ? normalisePhone(account.phoneNumber) : null;
  const envelope = args.envelopePhone
    ? normalisePhone(args.envelopePhone.startsWith("+") ? args.envelopePhone : `+${args.envelopePhone}`)
    : null;
  const replyTo = envelope ?? accountPhone;
  if (!replyTo) return null;
  const ownPhone = !!accountPhone && replyTo === accountPhone;

  const audience: HelpAudience = runs(membership) ? "admin" : "player";
  const links: Partial<Record<HelpAdminPage, string>> = {};
  // The admin group's own two topics read as the nearest players' one here.
  const pageTopic = req.topic === null ? null : playersHelpTopic(req.topic);
  if (audience === "admin" && ownPhone) {
    for (const page of helpPagesNeeded(pageTopic, audience)) {
      links[page] = await buildAdminLink({
        userId: args.userId,
        orgId: membership.orgId,
        nextPath: helpAdminPagePath(page, pageTopic),
      });
    }
  }

  const features = await getOrgFeatures(membership.orgId);
  const lang = features.language;
  const body = await clubHelpReply({
    orgId: membership.orgId,
    req,
    features,
    audience,
    links,
    poolEnv: args.poolEnv ?? (async () => ({})),
    dm: true,
  });
  const text = clubCount > 1 ? `${t(lang).onbHelpForClub({ club: membership.org.name })}\n\n${body}` : body;

  if (args.deliver === "platform") {
    // The help below says "tag me" and "say In or Out", and the group of a
    // club that is still setting up is one MatchTime is not listening to.
    // Say so first; the help itself is unchanged.
    const notStarted = t(lang).sj_go_help_not_started;
    await queuePlatformDm({ phone: replyTo, text: `${notStarted}\n\n${text}`, purpose: "setup-reply", refId: `${membership.orgId}:help` });
  } else {
    await db.botJob.create({
      data: { orgId: membership.orgId, kind: "dm", phone: replyTo.replace(/^\+/, ""), text, ...REPLY_PRIORITY },
    });
  }
  return { handled: "dm-help", topic: pageTopic, orgId: membership.orgId, audience };
}
