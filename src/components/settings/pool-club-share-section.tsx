"use client";

/**
 * "Tell your players about the player pool" (growth slice G3, 2026-10-24),
 * its own card on /admin/settings beside the other pool cards: the exact
 * post MatchTime would put in the players' group, with the club's link, and
 * one Send button. Sent once per club, ever; afterwards the card says when.
 * Renders nothing unless the club has the player pool. Loads and sends
 * through its own server actions (`app/actions/pool-club-share.ts`), so the
 * page only renders it.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";
import { poolClubShareCopy } from "@/lib/i18n/pool-club-share";
import { getClubShare, sendClubSharePost } from "@/app/actions/pool-club-share";
import type { ClubShareCard } from "@/lib/pool/club-share";

export function PoolClubShareSection(props: { orgId: string; language: string | null | undefined }) {
  const [card, setCard] = useState<ClubShareCard | null | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // A double tap is one send: the button is gone after the first, and the
  // server's claim is the real guard.
  const inFlight = useRef(false);

  useEffect(() => {
    getClubShare(props.orgId)
      .then((c) => setCard(c))
      .catch(() => setCard(null));
  }, [props.orgId]);

  if (!card) return null;
  const s = poolClubShareCopy(card.language);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const res = await sendClubSharePost(props.orgId);
      if (res.card) setCard(res.card);
      if (res.ok) toast.success(res.heldUntil ? s.held(res.heldUntil) : s.queued);
      else if (res.reason === "no-group") toast.error(s.noGroup);
      else if (res.reason !== "already-sent") toast.error(s.failed);
    } catch {
      toast.error(s.failed);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="pool-club-share" lang={card.language}>
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Megaphone className="w-4 h-4 text-slate-500" aria-hidden />
        <h2 className="font-semibold text-slate-800">{s.title}</h2>
      </div>
      <div className="p-6 space-y-4">
        <p className="text-sm text-slate-500">{s.lead}</p>
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1">{s.previewLabel}</p>
          <p
            className="text-sm text-slate-800 whitespace-pre-wrap break-words rounded-lg bg-slate-50 border border-slate-200 p-3"
            data-testid="pool-club-share-text"
          >
            {card.text}
          </p>
        </div>
        {card.kind === "sent" && card.sentOn ? (
          <p className="text-sm text-green-700" data-testid="pool-club-share-sent">
            {s.sentOn(card.sentOn)}
          </p>
        ) : card.kind === "no-group" ? (
          <p className="text-sm text-amber-700" data-testid="pool-club-share-no-group">
            {s.noGroup}
          </p>
        ) : (
          <button
            type="button"
            data-testid="pool-club-share-send"
            disabled={sending}
            onClick={() => void send()}
            className="w-full sm:w-auto px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:opacity-50"
          >
            {sending ? s.sending : s.send}
          </button>
        )}
      </div>
    </section>
  );
}
