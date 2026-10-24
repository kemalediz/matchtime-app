"use client";

/**
 * THE GUEST CARD (pool slice L5b, 2026-10-24). Approved spec: first name,
 * last initial, sports, optional level, turn-up record, games with this
 * club. Phone, area and other clubs are hidden: the card is built from
 * `GuestCard` (src/lib/pool/guest-report.ts), which carries none of them.
 *
 *   GuestCardDetails  the card's body (also rendered to HTML in unit tests).
 *   GuestCardTrigger  a button (his name, or the Guest tag on the match page)
 *                     that opens the card in a dialog.
 *   GuestTag          the plain "Guest" tag, for a viewer who is not an
 *                     organiser.
 *   InviteToClubButton  the card's Invite to club button; rendered only when
 *                     the page hands it L8's action (`club-invite.ts`).
 */
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/lib/i18n/t";
import type { GuestCard } from "@/lib/pool/guest-report";
import { guestName, guestSourceText, turnUpText } from "./guest-text";
import type { InviteToClubAction, InviteToClubState } from "@/lib/pool/club-invite";

export function GuestTag({ lang }: { lang: string | null | undefined }) {
  return (
    <span data-testid="guest-tag" className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
      {t(lang).gst_guest_tag}
    </span>
  );
}

export function InviteToClubButton(props: {
  orgId: string;
  userId: string;
  state: InviteToClubState;
  lang: string | null | undefined;
  action?: InviteToClubAction;
}) {
  const s = t(props.lang);
  const [state, setState] = useState(props.state);
  const [pending, start] = useTransition();
  if (!props.action || state === "hidden") return null;
  const action = props.action;
  if (state === "invited")
    return (
      <p data-testid="guest-invite-invited" className="text-sm text-slate-600">
        {s.gst_invite_invited}
      </p>
    );
  const unavailable = state === "unavailable";
  const noteId = `guest-invite-note-${props.userId}`;
  const invite = () =>
    start(async () => {
      try {
        const r = await action({ orgId: props.orgId, userId: props.userId });
        if (r.ok || r.reason === "already-invited") setState("invited");
        else toast.error(s.gst_invite_failed);
      } catch {
        toast.error(s.gst_invite_failed);
      }
    });
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="guest-invite"
        disabled={unavailable || pending}
        aria-describedby={unavailable ? noteId : undefined}
        onClick={invite}
        className="h-10 px-4 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-500"
      >
        {s.gst_invite}
      </button>
      {unavailable && (
        <p id={noteId} data-testid="guest-invite-unavailable" className="text-xs text-slate-500">
          {s.gst_invite_unavailable}
        </p>
      )}
    </div>
  );
}

export function GuestCardDetails(props: { card: GuestCard; lang: string | null | undefined; orgId: string; inviteAction?: InviteToClubAction }) {
  const s = t(props.lang);
  const c = props.card;
  const row = "grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-1 text-sm";
  return (
    <div data-testid="guest-card-details" className="space-y-3">
      <dl className="space-y-2">
        <div className={row}>
          <dt className="text-slate-500">{s.gst_card_source}</dt>
          <dd data-testid="guest-card-source" className="text-slate-800">
            {guestSourceText(s, c)}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">{s.gst_card_sports}</dt>
          <dd data-testid="guest-card-sports" className="text-slate-800">
            <ul>
              {c.sports.map((sp) => (
                <li key={sp.label}>
                  {sp.label}
                  {sp.level && <span className="text-slate-500">, {sp.level}</span>}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">{s.gst_card_record}</dt>
          <dd data-testid="guest-card-record" className="text-slate-800">
            {turnUpText(s, c.record)}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">{s.gst_card_games}</dt>
          <dd data-testid="guest-card-games" className="text-slate-800">
            {s.gst_games_here({ n: c.gamesHere })}
          </dd>
        </div>
      </dl>
      <InviteToClubButton orgId={props.orgId} userId={c.userId} state={c.invite} lang={props.lang} action={props.inviteAction} />
    </div>
  );
}

/** Opens the card. `children` is what the button shows (his name by default). */
export function GuestCardTrigger(props: {
  card: GuestCard;
  lang: string | null | undefined;
  orgId: string;
  inviteAction?: InviteToClubAction;
  children?: ReactNode;
  className?: string;
}) {
  const s = t(props.lang);
  const name = guestName(s, props.card);
  return (
    <Dialog>
      <DialogTrigger
        data-testid="guest-card-open"
        aria-label={s.gst_card_open({ name })}
        className={props.className ?? "text-left font-medium text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"}
      >
        {props.children ?? name}
      </DialogTrigger>
      <DialogContent data-testid="guest-card">
        <DialogHeader>
          <DialogTitle data-testid="guest-card-name">{name}</DialogTitle>
        </DialogHeader>
        <GuestCardDetails card={props.card} lang={props.lang} orgId={props.orgId} inviteAction={props.inviteAction} />
      </DialogContent>
    </Dialog>
  );
}
