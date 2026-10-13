/**
 * The self-join status card on a club's admin home (slice 4, plan
 * section 5.2). Server component. Rendered only:
 *   - with SELF_JOIN_ENABLED on,
 *   - to the club's OWNER,
 *   - for a club that came through self-join (an existing club, Sutton
 *     FC included, gets `hidden` from `deriveConnectCard` and nothing
 *     renders).
 *
 * ONE EXCEPTION (go-live slice S5): a club that is approved but still
 * SETTING UP shows its card to its OWNER and its ADMINs (either may go
 * live), whatever the flag says. The state decides, not the flag: a club
 * waiting for GO is still waiting if self-join is switched off. The card
 * says the club is approved and silent, and links to the Go live banner
 * on the settings page. It never says "You're live".
 *
 * THE NUMBER. This is the only page that renders the MatchTime number,
 * and only in two states, both after the club exists and only to its
 * signed-in owner: inside the wa.me link while a code is live, and as
 * text once the DM has arrived (the organiser needs it to save the
 * contact before adding MatchTime to the group). The draft state does
 * not carry it at all: the button's server action hands the link back.
 */
import { db } from "@/lib/db";
import { t } from "@/lib/i18n/t";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";
import { setupHoldEnabledForRequest } from "@/lib/setup-hold-flag";
import { loadLatestConnect, matchtimeWaNumber } from "@/lib/club-connect";
import { connectPrefill, deriveConnectCard, formatPhoneForDisplay, waMeLink } from "@/lib/club-connect-rules";
import { SETUP_STAGE_SELECT, isClubSettingUp } from "@/lib/club-setup-rules";
import { CONNECT_FOCUS_STEPS, connectFocusStep } from "@/lib/connect-focus";
import { loadClubSetupView } from "@/lib/club-setup";
import Link from "next/link";
import { ConnectButton } from "./connect-button";
import { CardRefresher } from "./card-refresher";
import { SectionInfo } from "@/components/info/section-info";

/**
 * `showStep` ("finish connecting" mode, src/lib/connect-focus.ts): the
 * card is the whole page, so it also says which of its three steps the
 * organiser is on. Everything else about the card is the same.
 */
export async function ClubConnectCard({
  orgId,
  userId,
  showStep = false,
}: {
  orgId: string;
  userId: string;
  showStep?: boolean;
}) {
  const flagOn = await selfJoinEnabledForRequest();

  const [membership, org] = await Promise.all([
    db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true } }),
    db.organisation.findUnique({
      where: { id: orgId },
      select: { name: true, language: true, approvedAt: true, ...SETUP_STAGE_SELECT },
    }),
  ]);
  if (!org || !membership || membership.leftAt !== null) return null;
  const settingUp = isClubSettingUp(org);
  if (settingUp ? membership.role !== "OWNER" && membership.role !== "ADMIN" : !flagOn || membership.role !== "OWNER") {
    return null;
  }

  // Removed from its group before going live (the same test the Go live
  // banner and `goLiveClub` use): the card must not say MatchTime is in
  // the group. Read only for a club that is setting up; a failure here
  // falls back to the plain setting-up card, never to a broken page.
  const removedFromGroup = settingUp
    ? await loadClubSetupView(orgId).then(
        (v) => !!v?.removedFromGroup,
        () => false,
      )
    : false;

  const card = deriveConnectCard({
    org: { ...org, settingUp, removedFromGroup },
    latest: await loadLatestConnect(orgId),
    now: new Date(),
  });
  if (card.kind === "hidden") return null;

  const s = t(org.language);
  // With the approval hold on (SETUP_HOLD_ENABLED), approval no longer
  // makes the club live: MatchTime stays quiet until the organiser tells
  // it to start, and messages them as soon as the club is approved. The
  // pending card says that; with the hold off it says what it always did.
  const pendingText = card.kind === "pending" && (await setupHoldEnabledForRequest()) ? s.sj_card_pending_held : s.sj_card_pending;
  const number = matchtimeWaNumber();
  const owner = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });

  const step = showStep ? connectFocusStep(card.kind) : null;

  const tone =
    card.kind === "approved"
      ? "border-green-200 bg-green-50"
      : card.kind === "rejected"
        ? "border-slate-200 bg-slate-50"
        : card.kind === "setting_up"
          ? card.removed
            ? "border-amber-300 bg-amber-50"
            : "border-emerald-300 bg-emerald-50"
          : "border-blue-200 bg-blue-50";

  const button = (label: string) =>
    number ? (
      <ConnectButton orgId={orgId} label={label} fallbackError={s.sj_err_generic} />
    ) : (
      <p className="text-sm text-slate-700">{s.sj_card_unavailable}</p>
    );

  return (
    <section
      data-testid="club-connect-card"
      data-state={card.kind}
      data-removed={card.kind === "setting_up" && card.removed ? "true" : undefined}
      lang={org.language}
      className={`rounded-xl border p-5 shadow-sm space-y-3 ${tone}`}
    >
      {step !== null && (
        <div className="space-y-1.5">
          <p data-testid="club-connect-step" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {s.cf_step({ step, total: CONNECT_FOCUS_STEPS })}
          </p>
          <div aria-hidden className="flex gap-1.5">
            {Array.from({ length: CONNECT_FOCUS_STEPS }, (_, i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${i < step ? "bg-green-600" : "bg-slate-200"}`} />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1">
        <h2 className="font-semibold text-slate-800">{card.kind === "setting_up" ? (card.removed ? s.sj_card_removed_title : s.sj_live_title) : s.sj_card_title}</h2>
        {card.kind !== "setting_up" && <SectionInfo k="dash_connect" lang={org.language} />}
      </div>

      {card.kind === "draft" && (
        <>
          <p className="text-sm text-slate-700">{s.sj_card_draft}</p>
          {button(s.sj_button)}
        </>
      )}

      {card.kind === "expired" && (
        <>
          <p className="text-sm text-slate-700">{s.sj_card_expired}</p>
          {button(s.sj_button)}
        </>
      )}

      {card.kind === "issued" && (
        <>
          <p className="text-sm text-slate-700">{s.sj_card_issued}</p>
          <p className="text-sm font-mono font-semibold text-slate-900" data-testid="club-connect-code">
            {s.sj_card_code({ code: card.code })}
          </p>
          {card.siteCap && (
            <p
              data-testid="club-connect-site-cap"
              className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3"
            >
              {s.sj_site_cap_groups}
            </p>
          )}
          {card.mismatchFrom && owner?.phoneNumber && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {s.sj_card_wrong_number({ seen: card.mismatchFrom, expected: formatPhoneForDisplay(owner.phoneNumber) })}
            </p>
          )}
          {number && (
            <a
              data-testid="club-connect-link"
              href={waMeLink(number, connectPrefill(org.language, org.name, card.code))}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-11 px-4 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium"
            >
              {s.sj_button_again}
            </a>
          )}
        </>
      )}

      {card.kind === "dm_verified" && (
        <>
          <p className="text-sm text-slate-700">{s.sj_card_dm_verified}</p>
          <p className="text-sm font-semibold text-slate-900" data-testid="club-connect-history-tip">
            {s.sj_card_history_tip}
          </p>
          {number && (
            <p className="text-sm text-slate-800">
              {s.sj_card_number_label}:{" "}
              <span className="font-mono font-semibold whitespace-nowrap" data-testid="club-connect-number">
                {formatPhoneForDisplay(number)}
              </span>
            </p>
          )}
        </>
      )}

      {card.kind === "pending" && (
        <p className="text-sm text-slate-700">
          {card.addedByOther && card.group ? s.sj_card_pending_other({ group: card.group }) : pendingText}
        </p>
      )}

      {card.kind === "approved" && (
        <p className="text-sm text-green-900">{s.sj_card_approved({ group: card.group ?? org.name })}</p>
      )}

      {card.kind === "setting_up" && (
        <>
          <p data-testid="club-connect-setting-up-text" className="text-sm text-slate-800 [overflow-wrap:anywhere]">
            {card.removed ? s.sj_card_setting_up_removed({ group: card.group }) : s.sj_card_setting_up({ group: card.group })}
          </p>
          <Link
            href="/admin/settings#go-live"
            data-testid="club-connect-go-live"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
          >
            {card.removed ? s.sj_live_wa_link : s.sj_card_setting_up_link}
          </Link>
        </>
      )}

      {card.kind === "rejected" && <p className="text-sm text-slate-700">{s.sj_card_rejected}</p>}

      {(card.kind === "issued" || card.kind === "dm_verified" || card.kind === "pending") && <CardRefresher />}
    </section>
  );
}
