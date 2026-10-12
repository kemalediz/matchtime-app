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
 * from the club's settings as they are. It is fetched again:
 *   - whenever the page says a setting was saved (`refreshKey`);
 *   - when the organiser comes back to the tab or the window (the weekly
 *     game is changed on another page), through ONE handler, at most once
 *     every `PREVIEW_MIN_GAP_MS`;
 *   - never while a go-live request is in flight (server actions run one
 *     after another, so a preview must not sit in front of the GO), and
 *     never once the outcome is final: the listeners are removed.
 *
 * THE BUTTON comes before the preview, so on a phone it is reached without
 * scrolling past the whole message. Busy until done, with a ref so a
 * double tap sends one request (the pattern of /create-org). No confirm
 * step: the preview is on the page.
 *
 * ONE LIVE REGION, ALWAYS IN THE PAGE (review of PR #236, fix 2). Every
 * outcome, a refusal or a final one, is written into the same
 * `role="status"` node, which exists from the first render, so a screen
 * reader announces it. On a final outcome the button is gone, so the
 * focus is moved to the result's heading instead of dropping to the body.
 *
 * FINAL OUTCOMES, each with its own look (fix 1):
 *   "live"     this press took the club live, or an earlier press of the
 *              same person did (fix 4): green, "You're live" / "<club> is live";
 *   "already"  somebody else took it live first: green, says who by name;
 *   "closed"   the club is not waiting to go live at all (turned off, say):
 *              neutral, and never "already live".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, Loader2, Rocket } from "lucide-react";
import { goLiveClubAction, helloPreviewAction } from "@/app/actions/club-setup";
import { WhatsAppMessage } from "@/components/whatsapp-message";
import { goLiveSettled, goLiveStarted } from "@/lib/go-live-in-flight";
import { t } from "@/lib/i18n/t";

/** What /api/org/settings sends an owner or admin about the club's setup. */
export interface GoLiveSetup {
  settingUp: boolean;
  removedFromGroup: boolean;
  group: string | null;
}

/** The least time between two preview fetches caused by coming back to the tab. */
export const PREVIEW_MIN_GAP_MS = 5_000;

type Preview = { state: "loading" } | { state: "ready"; text: string } | { state: "failed" };
type Final = {
  kind: "live" | "already" | "closed";
  title: string;
  text: string | null;
  hello: string | null;
  /** The free period sentence and the club fee tip, when one started. */
  note?: string | null;
};

export function GoLiveBanner(props: {
  orgId: string;
  club: string;
  language: string | null | undefined;
  setup: GoLiveSetup;
  /** Bumped by the page after a settings save: the preview is fetched again. */
  refreshKey: number;
  /** Reload the page's settings from the server. Resolves false, or rejects, when that failed. */
  onChanged: () => Promise<boolean>;
  /** The club is live: update the page's own state, without the server. */
  onLive: () => void;
}) {
  const s = t(props.language);
  const { orgId } = props;
  const group = props.setup.group;
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** A press was refused because MatchTime is no longer in the group. */
  const [removedNow, setRemovedNow] = useState(false);
  const [final, setFinal] = useState<Final | null>(null);
  const [stale, setStale] = useState(false);
  const submitting = useRef(false);
  const latest = useRef(0);
  const lastFetchAt = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const isFinal = final !== null;

  const loadPreview = useCallback(
    (why: "must" | "came-back") => {
      // Never beside a go-live request: it would queue in front of it.
      if (submitting.current) return;
      const now = Date.now();
      if (why === "came-back" && now - lastFetchAt.current < PREVIEW_MIN_GAP_MS) return;
      lastFetchAt.current = now;
      const mine = ++latest.current;
      helloPreviewAction(orgId)
        .then((text) => {
          if (latest.current === mine) setPreview({ state: "ready", text });
        })
        .catch(() => {
          // Keep a message already shown; only an empty box says it failed.
          if (latest.current === mine) setPreview((prev) => (prev.state === "ready" ? prev : { state: "failed" }));
        });
    },
    [orgId],
  );

  useEffect(() => {
    if (isFinal) return;
    loadPreview("must");
  }, [loadPreview, props.refreshKey, isFinal]);

  // Coming back to the tab fires both events; one handler, one fetch.
  useEffect(() => {
    if (isFinal) return;
    const cameBack = () => {
      if (document.visibilityState === "visible") loadPreview("came-back");
    };
    window.addEventListener("focus", cameBack);
    document.addEventListener("visibilitychange", cameBack);
    return () => {
      window.removeEventListener("focus", cameBack);
      document.removeEventListener("visibilitychange", cameBack);
    };
  }, [loadPreview, isFinal]);

  // The card on the admin home and the WhatsApp section link to #go-live;
  // the banner is not in the page yet when the browser looks for it.
  useEffect(() => {
    if (window.location.hash === "#go-live") document.getElementById("go-live")?.scrollIntoView({ block: "start" });
  }, []);

  // The button has gone: the result's heading takes the focus.
  useEffect(() => {
    if (isFinal) heading.current?.focus();
  }, [isFinal]);

  /** Bring the rest of the page up to date; say so when that failed. */
  async function refreshPage() {
    const ok = await props.onChanged().then(
      (v) => v,
      () => false,
    );
    if (!ok) setStale(true);
  }

  async function goLive() {
    if (submitting.current) return;
    submitting.current = true;
    goLiveStarted(); // nothing else on the page may queue a request beside this one
    setBusy(true);
    setNotice(null);
    // Stays locked once the outcome is final: there is nothing left to press.
    let closed = false;
    try {
      const r = await goLiveClubAction(orgId);
      switch (r.outcome) {
        case "went-live":
          closed = true;
          // AFTER GOING LIVE (PR #237, billing): the free period sentence
          // and the club fee tip, when the club's free period started with
          // this go-live. Rendered in the marked spot below.
          setFinal({
            kind: "live",
            title: s.sj_live_done_title,
            text: s.sj_live_done({ group: r.group }),
            hello: r.hello,
            note: r.freePeriodNote,
          });
          props.onLive();
          void refreshPage();
          break;
        case "already-live":
          closed = true;
          setFinal(
            r.by === "you"
              ? // Their own earlier press worked and its answer was lost.
                { kind: "live", title: s.sj_live_is_live({ club: r.club }), text: null, hello: null }
              : {
                  kind: "already",
                  title: s.sj_go_already_live({ club: r.club }),
                  text:
                    r.by === "unknown"
                      ? null
                      : s.sj_live_already({ club: r.club, by: r.byName, matchTime: r.by === "matchtime" }),
                  hello: null,
                },
          );
          props.onLive();
          void refreshPage();
          break;
        case "not-setting-up":
          closed = true;
          setFinal({ kind: "closed", title: s.sj_live_closed_title, text: s.sj_live_not_setting_up, hello: null });
          void refreshPage();
          break;
        case "still-reading":
          setNotice(s.sj_live_still_reading);
          break;
        case "removed-from-group":
          setRemovedNow(true);
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
      goLiveSettled();
      setBusy(false);
    }
  }

  // Known before anything is pressed: MatchTime is no longer in the group.
  // Or learnt from a press that was refused for it.
  const removed = props.setup.removedFromGroup || removedNow;
  const shown = notice ?? (props.setup.removedFromGroup ? s.sj_live_removed({ group: group ?? props.club }) : null);
  const neutral = final?.kind === "closed";

  // ONE tree for every state, so the live region below is the same DOM
  // node before and after an outcome.
  return (
    <section
      id="go-live"
      aria-labelledby="go-live-heading"
      data-testid={final ? "go-live-done" : "go-live-banner"}
      data-outcome={final?.kind}
      lang={props.language ?? undefined}
      className={`scroll-mt-6 min-w-0 rounded-xl border p-5 shadow-sm sm:p-6 ${
        neutral
          ? "border-slate-300 bg-slate-50"
          : final
            ? "border-emerald-300 bg-emerald-50"
            : "border-l-4 border-emerald-300 border-l-emerald-600 bg-emerald-50"
      }`}
    >
      {!final && (
        <div className="min-w-0">
          <h2 id="go-live-heading" className="text-lg font-semibold text-emerald-950">
            {/* Its own heading while MatchTime is out of the group:
                "Approved. MatchTime is waiting for you." above "MatchTime
                is not in X any more" said two things at once. */}
            {removed ? s.sj_live_title_removed : s.sj_live_title}
          </h2>
          {/* Not while MatchTime is out of the group: "MatchTime is in
              <group>" would contradict the notice below. */}
          {!removed && (
            <p data-testid="go-live-lead" className="mt-1 text-sm text-slate-800 [overflow-wrap:anywhere]">
              {s.sj_live_lead({ group })}
            </p>
          )}
          {/* WHICH CLUB: somebody who runs more than one club that is
              setting up must see, right at the button, which one this
              page takes live. The button's accessible name says it too. */}
          <p data-testid="go-live-club" className="mt-3 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">
            {s.sj_live_for_club({ club: props.club })}
          </p>
        </div>
      )}

      {!final && (
        <button
          type="button"
          data-testid="go-live-button"
          onClick={goLive}
          disabled={busy}
          aria-busy={busy}
          aria-label={busy ? undefined : s.sj_live_button_label({ club: props.club })}
          className="mt-2 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-6 text-base font-semibold text-white hover:bg-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Rocket aria-hidden="true" className="h-5 w-5" />}
          {busy ? s.sj_live_busy : s.sj_go_button}
        </button>
      )}

      {/* THE live region: in the page from the first render, for every outcome. */}
      <div role="status" aria-live="polite" data-testid="go-live-status" className="min-w-0">
        {final ? (
          <div className="flex items-start gap-3">
            {neutral ? (
              <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
            )}
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <h2
                id="go-live-heading"
                ref={heading}
                tabIndex={-1}
                className={`font-semibold focus:outline-none focus-visible:underline ${neutral ? "text-slate-800" : "text-emerald-950"}`}
              >
                {final.title}
              </h2>
              {final.text && (
                <p data-testid="go-live-done-text" className={`mt-0.5 text-sm ${neutral ? "text-slate-700" : "text-emerald-950"}`}>
                  {final.text}
                </p>
              )}
              {/* AFTER GOING LIVE (PR #237, billing): the free period
                  sentence and the club fee tip, as the WhatsApp reply has
                  them (bold and all). Inside the live region, so it is
                  announced with the result. */}
              {final.note && (
                <div className="mt-2">
                  <WhatsAppMessage text={final.note} testId="go-live-free-period" />
                </div>
              )}
            </div>
          </div>
        ) : (
          shown && (
            <p
              data-testid="go-live-notice"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 [overflow-wrap:anywhere]"
            >
              {shown}
            </p>
          )
        )}
      </div>

      {final && stale && (
        <p data-testid="go-live-stale" className="mt-3 text-sm text-slate-700">
          {s.sj_live_stale}{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-medium text-emerald-800 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            {s.sj_live_reload}
          </button>
        </p>
      )}

      {final?.hello && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-emerald-900">{s.sj_live_done_posted}</summary>
          <div className="mt-2">
            <WhatsAppMessage text={final.hello} testId="go-live-posted" />
          </div>
        </details>
      )}

      {!final && (
        <div className="mt-4 min-w-0">
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
      )}
    </section>
  );
}
