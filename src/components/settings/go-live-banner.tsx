"use client";

/**
 * THE GO LIVE BANNER on /admin/settings (go-live slice S5, 2026-10-12).
 *
 * A club that the MatchTime owner has approved is "setting up": MatchTime
 * is in its WhatsApp group and silent until an owner or admin of the club
 * says GO. This is that GO on the website: what is going on, the Go live
 * button, and the exact hello MatchTime will post.
 *
 * THE PREVIEW IS THE REAL MESSAGE. It comes from `helloPreviewAction`,
 * which builds it the way `goLiveClub` does at the instant of go-live,
 * from the club's settings as they are. It is fetched again whenever the
 * page says a setting was saved (`refreshKey`), and whenever the tab gets
 * the focus back (the weekly game is changed on another page).
 *
 * THE BUTTON comes before the preview, so on a phone it is reached without
 * scrolling past the whole message. Busy until done, with a ref so a
 * double tap sends one request (the pattern of /create-org). No confirm
 * step: the preview is on the page.
 *
 * Every outcome of `goLiveClubAction` is worded here. Going live replaces
 * the banner with a note; so does finding the club already live.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Rocket } from "lucide-react";
import { goLiveClubAction, helloPreviewAction } from "@/app/actions/club-setup";
import { WhatsAppMessage } from "@/components/whatsapp-message";
import { t } from "@/lib/i18n/t";

/** What /api/org/settings sends an owner or admin about the club's setup. */
export interface GoLiveSetup {
  settingUp: boolean;
  removedFromGroup: boolean;
  group: string | null;
  wentLiveBy: { matchTime: boolean; name: string | null } | null;
}

type Preview = { state: "loading" } | { state: "ready"; text: string } | { state: "failed" };
type Final = { kind: "live"; group: string; hello: string } | { kind: "closed"; text: string };

export function GoLiveBanner(props: {
  orgId: string;
  club: string;
  language: string | null | undefined;
  setup: GoLiveSetup;
  /** Bumped by the page after a settings save: the preview is fetched again. */
  refreshKey: number;
  /** Reload the page's settings; resolves with the club's setup as it is now. */
  onChanged: () => Promise<GoLiveSetup | null>;
}) {
  const s = t(props.language);
  const { orgId } = props;
  const group = props.setup.group;
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [final, setFinal] = useState<Final | null>(null);
  const submitting = useRef(false);
  const latest = useRef(0);

  const loadPreview = useCallback(() => {
    const mine = ++latest.current;
    helloPreviewAction(orgId)
      .then((text) => {
        if (latest.current === mine) setPreview({ state: "ready", text });
      })
      .catch(() => {
        // Keep a message already shown; only an empty box says it failed.
        if (latest.current === mine) setPreview((prev) => (prev.state === "ready" ? prev : { state: "failed" }));
      });
  }, [orgId]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview, props.refreshKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") loadPreview();
    };
    window.addEventListener("focus", loadPreview);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", loadPreview);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadPreview]);

  // The card on the admin home and the WhatsApp section link to #go-live;
  // the banner is not in the page yet when the browser looks for it.
  useEffect(() => {
    if (window.location.hash === "#go-live") document.getElementById("go-live")?.scrollIntoView({ block: "start" });
  }, []);

  async function goLive() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    // Stays locked once the club is live or no longer waiting: there is
    // nothing left to press.
    let closed = false;
    try {
      const r = await goLiveClubAction(orgId);
      switch (r.outcome) {
        case "went-live":
          closed = true;
          setFinal({ kind: "live", group: r.group, hello: r.hello });
          void props.onChanged();
          break;
        case "already-live": {
          closed = true;
          const now = await props.onChanged().catch(() => null);
          setFinal({
            kind: "closed",
            text: s.sj_live_already({
              club: r.club,
              by: now?.wentLiveBy?.name ?? null,
              matchTime: !!now?.wentLiveBy?.matchTime,
            }),
          });
          break;
        }
        case "not-setting-up":
          closed = true;
          setFinal({ kind: "closed", text: s.sj_live_not_setting_up });
          void props.onChanged();
          break;
        case "still-reading":
          setNotice(s.sj_live_still_reading);
          break;
        case "removed-from-group":
          setNotice(s.sj_live_removed({ group: r.group }));
          break;
        case "billing-paused":
          setNotice(s.sj_live_paused({ club: r.club }));
          break;
      }
    } catch {
      setNotice(s.sj_live_failed);
    } finally {
      if (!closed) submitting.current = false;
      setBusy(false);
    }
  }

  if (final) {
    return (
      <section
        id="go-live"
        aria-labelledby="go-live-heading"
        data-testid="go-live-done"
        data-outcome={final.kind}
        lang={props.language ?? undefined}
        className="scroll-mt-6 rounded-xl border border-emerald-300 bg-emerald-50 p-5 shadow-sm sm:p-6"
      >
        <div role="status" className="flex items-start gap-3">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
          <div className="min-w-0">
            <h2 id="go-live-heading" className="font-semibold text-emerald-950">
              {final.kind === "live" ? s.sj_live_done_title : s.sj_go_already_live({ club: props.club })}
            </h2>
            <p data-testid="go-live-done-text" className="mt-0.5 text-sm text-emerald-950">
              {final.kind === "live" ? s.sj_live_done({ group: final.group }) : final.text}
            </p>
          </div>
        </div>
        {final.kind === "live" && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-emerald-900">{s.sj_live_done_posted}</summary>
            <div className="mt-2">
              <WhatsAppMessage text={final.hello} testId="go-live-posted" />
            </div>
          </details>
        )}
      </section>
    );
  }

  // Known before anything is pressed: MatchTime is no longer in the group.
  const shown = notice ?? (props.setup.removedFromGroup ? s.sj_live_removed({ group: group ?? props.club }) : null);

  return (
    <section
      id="go-live"
      aria-labelledby="go-live-heading"
      data-testid="go-live-banner"
      lang={props.language ?? undefined}
      className="scroll-mt-6 space-y-4 rounded-xl border border-l-4 border-emerald-300 border-l-emerald-600 bg-emerald-50 p-5 shadow-sm sm:p-6"
    >
      <div>
        <h2 id="go-live-heading" className="text-lg font-semibold text-emerald-950">
          {s.sj_live_title}
        </h2>
        <p className="mt-1 text-sm text-slate-800">{s.sj_live_lead({ group })}</p>
      </div>

      <div>
        <button
          type="button"
          data-testid="go-live-button"
          onClick={goLive}
          disabled={busy}
          aria-busy={busy}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-6 text-base font-semibold text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Rocket aria-hidden="true" className="h-5 w-5" />}
          {busy ? s.sj_live_busy : s.sj_go_button}
        </button>
        <div aria-live="polite">
          {shown && (
            <p
              data-testid="go-live-notice"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            >
              {shown}
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <h3 id="go-live-preview-heading" className="text-sm font-semibold text-slate-800">
          {s.sj_live_preview_title}
        </h3>
        <p className="mb-2 mt-0.5 text-xs text-slate-600">{s.sj_live_preview_note}</p>
        {preview.state === "ready" ? (
          <WhatsAppMessage text={preview.text} testId="go-live-preview" labelledBy="go-live-preview-heading" />
        ) : (
          <p data-testid={`go-live-preview-${preview.state}`} className="text-sm text-slate-600">
            {preview.state === "loading" ? s.sj_live_preview_loading : s.sj_live_preview_failed}
          </p>
        )}
      </div>
    </section>
  );
}
