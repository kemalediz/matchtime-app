"use client";

/**
 * "Same person?" (FNF incident 2026-10-18). Shown on /admin/players when
 * the number an admin typed belongs to a MatchTime user at another club
 * and the rules allow linking (src/lib/cross-club-link-rules.ts).
 *
 * It shows the other user's FIRST name and their club's name, and
 * nothing else from that club. Closing it any way other than "Yes" is a
 * "No": the number stays unsaved.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/t";
import type { Lang } from "@/lib/i18n/lang";
import type { PhoneLinkOffer } from "@/app/actions/players";

export function PhoneLinkDialog({
  offer,
  lang,
  busy,
  onYes,
  onNo,
}: {
  offer: PhoneLinkOffer | null;
  lang: Lang;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  const s = t(lang);
  return (
    <Dialog
      open={offer !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onNo();
      }}
    >
      {offer && (
        <DialogContent data-testid="phone-link-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{s.phone_link_title}</DialogTitle>
            <DialogDescription data-testid="phone-link-question">
              {s.phone_link_question({ name: offer.firstName, clubs: offer.clubNames })}
            </DialogDescription>
          </DialogHeader>
          {offer.thisClub && <p className="text-xs text-slate-500">{s.phone_link_explain({ club: offer.thisClub })}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onNo}>
              {s.phone_link_no}
            </Button>
            <Button disabled={busy} onClick={onYes}>
              {s.phone_link_yes}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
