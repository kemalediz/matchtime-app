import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import {
  APPROVED_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  REJECTED_CLUB_WHERE,
  SELF_JOIN_CLUB_WHERE,
  SUSPENDED_CLUB_WHERE,
} from "@/lib/club-approval";
import { adderLine, type AdderMatch } from "@/lib/group-add-rules";
import { maskPhoneForCard, MAX_GROUP_LINKS_PER_DAY } from "@/lib/connect-dm-rules";
import { formatPhoneForDisplay, londonMidnight, MAX_NEW_CLUBS_PER_DAY } from "@/lib/club-connect-rules";
import { SITE_SIGNUP_CODES_PER_DAY } from "@/lib/signup-caps";
import { parseParticipantSnapshot, snapshotPhone } from "@/lib/participant-snapshot";
import { londonDay, getAiBudgetStatus } from "@/lib/ai-budget";
import { NEW_CLUB_DM_WINDOW_DAYS, newClubDmCap } from "@/lib/club-decision-rules";
import { countOrgDmsSince } from "@/lib/org-dm-count";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";
import { notFound, redirect } from "next/navigation";
import { DecideButtons, LeaveButton, TurnOffButton } from "./club-buttons";

/**
 * /admin/clubs: the platform owner's decisions on self-join clubs (slice 7).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 6.4.
 *
 * The same decisions as the WhatsApp reply ("APPROVE 7KQ2"), through the
 * same single writer, `decideClub`. The fallback when a reply cannot be
 * read (a LID-only sender) and the only place to Turn off a club or Leave
 * a group somebody added MatchTime to with no code.
 *
 * OWNER ONLY. 404 to anybody who is not `User.isSuperadmin`, exactly as
 * /admin/health: it names other clubs, organisers and their numbers.
 *
 * SUTTON FC IS NOT ON THIS PAGE. Only clubs that came in through self-join
 * are listed (`approvedAt` set by an approval, or not approved at all), so
 * no button here can reach a club that predates self-join; `decideClub`
 * refuses it again behind the button.
 */
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

function when(d: Date | null | undefined): string {
  return d ? formatLondon(d, "EEE d MMM, HH:mm") : "";
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} data-testid={`section-${id}`}>
      <h3 id={id} className="text-sm font-semibold text-slate-700">
        {title}
      </h3>
      {lead && <p className="mt-0.5 mb-3 text-xs text-slate-500">{lead}</p>}
      <div className={lead ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

export default async function ClubsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();

  const now = new Date();
  const midnight = londonMidnight(now);
  const selfJoinOn = await selfJoinEnabledForRequest();

  const [waitingRows, liveOrgs, rejectedOrgs, suspendedOrgs, unsolicited, signupCodes, newClubs, links] =
    await Promise.all([
      db.clubConnect.findMany({
        where: { status: "group_linked", botRemovedAt: null, org: PENDING_CLUB_WHERE },
        orderBy: { linkedAt: "asc" },
        select: {
          id: true,
          orgId: true,
          userId: true,
          code: true,
          phone: true,
          dmAt: true,
          dmPhone: true,
          groupSubject: true,
          memberCount: true,
          adderMatch: true,
          detectedLang: true,
          participants: true,
          linkedAt: true,
          org: { select: { name: true, language: true } },
        },
      }),
      db.organisation.findMany({
        where: { ...APPROVED_CLUB_WHERE, approvedAt: { not: null } },
        orderBy: { approvedAt: "desc" },
        select: { id: true, name: true, approvedAt: true, whatsappGroupId: true, whatsappBotEnabled: true },
      }),
      db.organisation.findMany({
        where: REJECTED_CLUB_WHERE,
        orderBy: { approvalDecidedAt: "desc" },
        take: 20,
        select: { id: true, name: true, approvalDecidedAt: true },
      }),
      db.organisation.findMany({
        where: SUSPENDED_CLUB_WHERE,
        orderBy: { approvalDecidedAt: "desc" },
        take: 20,
        select: { id: true, name: true, approvalDecidedAt: true },
      }),
      db.unsolicitedGroup.findMany({
        where: { OR: [{ leftAt: null }, { leftAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }] },
        orderBy: { addedAt: "desc" },
        take: 50,
      }),
      db.phoneOtp.count({ where: { createdAt: { gte: midnight } } }),
      db.organisation.count({ where: { ...SELF_JOIN_CLUB_WHERE, createdAt: { gte: midnight } } }),
      db.clubConnect.count({ where: { dmAt: { gte: midnight } } }),
    ]);

  // Who organises each waiting club, and what each has spent today (must be $0).
  const organisers = await db.user.findMany({
    where: { id: { in: waitingRows.map((w) => w.userId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(organisers.map((u) => [u.id, u.name]));
  const pendingSpend = waitingRows.length
    ? await db.orgAiUsage.findMany({
        where: { orgId: { in: waitingRows.map((w) => w.orgId) }, day: new Date(`${londonDay(now)}T00:00:00Z`) },
        select: { orgId: true, costUsd: true },
      })
    : [];
  const spendOf = new Map(pendingSpend.map((r) => [r.orgId, r.costUsd]));

  const live = await Promise.all(
    liveOrgs.map(async (o) => {
      const cap = newClubDmCap(o, now);
      const [dmsToday, ai] = await Promise.all([
        cap !== null ? countOrgDmsSince(o.id, midnight) : Promise.resolve(null),
        getAiBudgetStatus(o.id, now),
      ]);
      return { ...o, cap, dmsToday, ai, newClub: cap !== null };
    }),
  );

  const leaveJobs = unsolicited.length
    ? await db.platformJob.findMany({
        where: { kind: "leave-group", groupId: { in: unsolicited.map((u) => u.groupId) } },
        orderBy: { createdAt: "desc" },
        select: { groupId: true, status: true, createdAt: true },
      })
    : [];

  return (
    <div className="space-y-8" data-testid="clubs-page">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Clubs</h2>
        <p className="text-sm text-slate-500 mt-1">
          Clubs that joined MatchTime themselves. Approve or reject the ones waiting, turn a new club off, or leave a
          group nobody asked MatchTime into. The same as replying APPROVE or REJECT with the ref on WhatsApp. Clubs
          that were here before self-join are not listed and cannot be changed from this page.
        </p>
        {!selfJoinOn && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Self-join is switched off (SELF_JOIN_ENABLED), so nothing can be approved. Reject, Turn off and Leave still
            work.
          </p>
        )}
      </div>

      <Section id="waiting" title="Waiting for you" lead="Oldest first. MatchTime is silent in these groups until you decide.">
        {waitingRows.length === 0 ? (
          <Empty>No club is waiting.</Empty>
        ) : (
          <ul className="space-y-3">
            {waitingRows.map((w) => {
              const snapshot = parseParticipantSnapshot(w.participants);
              const organiserPresent = snapshot.some((p) => snapshotPhone(p)?.replace(/^\+/, "") === w.phone);
              const spent = spendOf.get(w.orgId) ?? 0;
              return (
                <li key={w.id} data-testid="waiting-club" className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-800">
                      {w.org.name} <span className="text-xs font-normal text-slate-500">ref {w.code}</span>
                    </span>
                    <span className="text-xs text-slate-500">linked {when(w.linkedAt)}</span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm text-slate-700 sm:grid-cols-[8rem_1fr]">
                    <dt className="text-slate-500">Organiser</dt>
                    <dd>
                      {nameOf.get(w.userId) ?? "(no name)"}, {formatPhoneForDisplay(w.phone)} (phone verified at sign-up)
                    </dd>
                    <dt className="text-slate-500">Added by</dt>
                    <dd>
                      {adderLine((w.adderMatch ?? "unknown") as AdderMatch, organiserPresent, w.dmAt !== null && w.dmPhone === null).replace(
                        /^Added by: /,
                        "",
                      )}
                    </dd>
                    <dt className="text-slate-500">Group</dt>
                    <dd>
                      &quot;{w.groupSubject ?? "(no name)"}&quot;, {w.memberCount ?? 0} members, looks{" "}
                      {w.detectedLang === "tr" ? "Turkish" : "English"} (club chose{" "}
                      {w.org.language === "tr" ? "Türkçe" : "English"})
                    </dd>
                    <dt className="text-slate-500">AI spend today</dt>
                    <dd data-testid="pending-ai-spend" className={spent > 0 ? "font-semibold text-red-700" : ""}>
                      {usd(spent)}
                      {spent > 0 && " (should be $0.00 while waiting: a silence rail is broken)"}
                    </dd>
                  </dl>
                  {snapshot.length > 0 && (
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer text-slate-600">Members ({snapshot.length})</summary>
                      <ul className="mt-1 columns-1 sm:columns-2 text-slate-600">
                        {snapshot.map((p, i) => (
                          <li key={i}>
                            {p.pushname ?? "(no name)"}
                            {p.phone ? `, ${maskPhoneForCard(p.phone)}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="mt-3">
                    <DecideButtons orgId={w.orgId} club={w.org.name} canApprove={selfJoinOn} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        id="live"
        title="Live clubs that joined themselves"
        lead={`New clubs get ${NEW_CLUB_DM_WINDOW_DAYS} days of tighter limits from the day you approve them.`}
      >
        {live.length === 0 ? (
          <Empty>No self-join club is live yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {live.map((c) => (
              <li key={c.id} data-testid="live-club" className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{c.name}</span>
                  {c.newClub && (
                    <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-800">
                      First {NEW_CLUB_DM_WINDOW_DAYS} days
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  Approved {when(c.approvedAt)}.
                  {c.dmsToday !== null && ` DMs today: ${c.dmsToday} of ${c.cap}.`} AI today: {usd(c.ai.spentUsd)} of{" "}
                  {usd(c.ai.capUsd)}
                  {c.ai.capped ? " (capped)" : ""}.{!c.whatsappBotEnabled && " Muted."}
                </p>
                <div className="mt-3">
                  <TurnOffButton orgId={c.id} club={c.name} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="unsolicited" title="Groups nobody asked MatchTime into" lead="Silent. MatchTime leaves these by itself after 48 hours.">
        {unsolicited.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="space-y-2">
            {unsolicited.map((u) => {
              const job = leaveJobs.find((j) => j.groupId === u.groupId && j.createdAt >= u.addedAt);
              const subject = u.subject ?? "(no name)";
              return (
                <li
                  key={u.id}
                  data-testid="unsolicited-group"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm"
                >
                  <span className="text-slate-700">
                    &quot;{subject}&quot;, {u.memberCount ?? 0} members, added {when(u.addedAt)} by{" "}
                    {u.addedByPhone ? maskPhoneForCard(u.addedByPhone) : "someone unknown"}
                  </span>
                  {u.leftAt ? (
                    <span className="text-slate-500">Left {when(u.leftAt)}</span>
                  ) : job && (job.status === "queued" || job.status === "claimed") ? (
                    <span className="text-slate-500">Leaving</span>
                  ) : (
                    <LeaveButton id={u.id} subject={subject} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section id="rejected" title="Rejected">
          {rejectedOrgs.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="space-y-1 text-sm text-slate-700">
              {rejectedOrgs.map((o) => (
                <li key={o.id} data-testid="rejected-club">
                  {o.name} <span className="text-slate-500">{when(o.approvalDecidedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section id="suspended" title="Turned off">
          {suspendedOrgs.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="space-y-1 text-sm text-slate-700">
              {suspendedOrgs.map((o) => (
                <li key={o.id} data-testid="suspended-club">
                  {o.name} <span className="text-slate-500">{when(o.approvalDecidedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section id="limits" title="Today's site limits" lead="London day. They reset at midnight.">
        <ul className="grid gap-2 text-sm text-slate-700 sm:grid-cols-3" data-testid="site-limits">
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            Sign-up codes: {signupCodes} of {SITE_SIGNUP_CODES_PER_DAY}
          </li>
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            New clubs: {newClubs} of {MAX_NEW_CLUBS_PER_DAY}
          </li>
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            Groups connected: {links} of {MAX_GROUP_LINKS_PER_DAY}
          </li>
        </ul>
      </Section>
    </div>
  );
}
