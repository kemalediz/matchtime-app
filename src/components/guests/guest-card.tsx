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
 *   InviteToClubButton  the card's Invite to club button (and, for a guest
 *                     who asked to join after a game, Send the invite link
 *                     and Not now); rendered only when the page hands it
 *                     the action (`app/actions/club-invite.ts`, pool L8).
 *   `extra`           slice L7: the organisers' block and report controls
 *                     (`guest-safety.tsx`), handed in by the page.
 */
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/lib/i18n/t";
import type { GuestCard } from "@/lib/pool/guest-report";
import { guestName, guestSourceText, turnUpText } from "./guest-text";
import type { InviteToClubAction, InviteToClubState } from "@/lib/pool/club-invite";
import { inviteCopy } from "@/lib/i18n/pool-invite";
import { INVITE_LINK_SETTINGS_PATH } from "@/lib/pool/invite-link";

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
  /** The club has a way to send its group link (pool L8). Default true. */
  linkReady?: boolean;
}) {
  const s = t(props.lang);
  const c = inviteCopy(props.lang);
  const [state, setState] = useState(props.state);
  const [pending, start] = useTransition();
  if (!props.action || state === "hidden") return null;
  const action = props.action;
  if (state === "invited" || state === "link-sent")
    return (
      <p data-testid={state === "invited" ? "guest-invite-invited" : "guest-invite-link-sent"} className="text-sm text-slate-600">
        {state === "invited" ? s.gst_invite_invited : c.card_link_sent}
      </p>
    );
  const linkReady = props.linkReady !== false;
  const noteId = `guest-invite-note-${props.userId}`;
  const answer = (a: "yes" | "no") =>
    start(async () => {
      try {
        const r = await action({ orgId: props.orgId, userId: props.userId, answer: a });
        if (r.ok) {
          setState(r.state);
          toast.success(a === "no" ? c.card_closed_toast : state === "requested" ? c.card_link_sent_toast : c.card_invited_toast);
        } else if (r.reason === "already-invited") setState("invited");
        else toast.error(r.reason === "no-link" ? c.card_no_link : s.gst_invite_failed);
      } catch {
        toast.error(s.gst_invite_failed);
      }
    });
  const greyed = state === "unavailable" || state === "declined" || !linkReady;
  const note =
    state === "unavailable" ? (
      <p id={noteId} data-testid="guest-invite-unavailable" className="text-xs text-slate-500">
        {s.gst_invite_unavailable}
      </p>
    ) : state === "declined" ? (
      <p id={noteId} data-testid="guest-invite-declined" className="text-xs text-slate-500">
        {c.card_declined}
      </p>
    ) : !linkReady ? (
      <p id={noteId} data-testid="guest-invite-no-link" className="text-xs text-slate-500">
        {c.card_no_link}{" "}
        <a href={INVITE_LINK_SETTINGS_PATH} className="font-medium text-blue-700 underline underline-offset-2">
          {c.card_no_link_cta}
        </a>
      </p>
    ) : null;
  const button = "h-10 px-4 rounded-lg text-sm font-medium disabled:bg-slate-200 disabled:text-slate-500";
  if (state === "requested")
    return (
      <div className="space-y-2" data-testid="guest-invite-requested">
        <p className="text-sm font-medium text-slate-800">{c.card_requested}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="guest-invite-send"
            disabled={greyed || pending}
            aria-describedby={note ? noteId : undefined}
            onClick={() => answer("yes")}
            className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
          >
            {c.card_send_link}
          </button>
          <button
            type="button"
            data-testid="guest-invite-not-now"
            disabled={pending}
            onClick={() => answer("no")}
            className={`${button} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}
          >
            {c.card_not_now}
          </button>
        </div>
        {note}
      </div>
    );
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="guest-invite"
        disabled={greyed || pending}
        aria-describedby={note ? noteId : undefined}
        onClick={() => answer("yes")}
        className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
      >
        {s.gst_invite}
      </button>
      {note}
    </div>
  );
}

export function GuestCardDetails(props: { card: GuestCard; lang: string | null | undefined; orgId: string; inviteAction?: InviteToClubAction; linkReady?: boolean; extra?: ReactNode }) {
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
      <InviteToClubButton orgId={props.orgId} userId={c.userId} state={c.invite} lang={props.lang} action={props.inviteAction} linkReady={props.linkReady} />
      {props.extra}
    </div>
  );
}

/** Opens the card. `children` is what the button shows (his name by default). */
export function GuestCardTrigger(props: {
  card: GuestCard;
  lang: string | null | undefined;
  orgId: string;
  inviteAction?: InviteToClubAction;
  linkReady?: boolean;
  children?: ReactNode;
  className?: string;
  /** Slice L7: the organisers' block and report controls (`GuestSafety`). */
  extra?: ReactNode;
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
        <GuestCardDetails card={props.card} lang={props.lang} orgId={props.orgId} inviteAction={props.inviteAction} linkReady={props.linkReady} extra={props.extra} />
      </DialogContent>
    </Dialog>
  );
}
