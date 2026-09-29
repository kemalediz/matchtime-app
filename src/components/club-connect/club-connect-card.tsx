/**
 * The self-join status card on a club's admin home (slice 4, plan
 * section 5.2). Server component. Rendered only:
 *   - with SELF_JOIN_ENABLED on,
 *   - to the club's OWNER,
 *   - for a club that came through self-join (an existing club, Sutton
 *     FC included, gets `hidden` from `deriveConnectCard` and nothing
 *     renders).
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
import { loadLatestConnect, matchtimeWaNumber } from "@/lib/club-connect";
import { connectPrefill, deriveConnectCard, formatPhoneForDisplay, waMeLink } from "@/lib/club-connect-rules";
import { ConnectButton } from "./connect-button";
import { CardRefresher } from "./card-refresher";

export async function ClubConnectCard({ orgId, userId }: { orgId: string; userId: string }) {
  if (!(await selfJoinEnabledForRequest())) return null;

  const [membership, org] = await Promise.all([
    db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true } }),
    db.organisation.findUnique({
      where: { id: orgId },
      select: { name: true, language: true, approvalStatus: true, approvedAt: true },
    }),
  ]);
  if (!org || !membership || membership.leftAt !== null || membership.role !== "OWNER") return null;

  const card = deriveConnectCard({ org, latest: await loadLatestConnect(orgId), now: new Date() });
  if (card.kind === "hidden") return null;

  const s = t(org.language);
  const number = matchtimeWaNumber();
  const owner = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });

  const tone =
    card.kind === "approved"
      ? "border-green-200 bg-green-50"
      : card.kind === "rejected"
        ? "border-slate-200 bg-slate-50"
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
      lang={org.language}
      className={`rounded-xl border p-5 shadow-sm space-y-3 ${tone}`}
    >
      <h2 className="font-semibold text-slate-800">{s.sj_card_title}</h2>

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
          {card.addedByOther && card.group ? s.sj_card_pending_other({ group: card.group }) : s.sj_card_pending}
        </p>
      )}

      {card.kind === "approved" && (
        <p className="text-sm text-green-900">{s.sj_card_approved({ group: card.group ?? org.name })}</p>
      )}

      {card.kind === "rejected" && <p className="text-sm text-slate-700">{s.sj_card_rejected}</p>}

      {(card.kind === "issued" || card.kind === "dm_verified" || card.kind === "pending") && <CardRefresher />}
    </section>
  );
}
