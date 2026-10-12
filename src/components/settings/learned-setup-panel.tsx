"use client";

/**
 * "Set up from your group chat" on /admin/settings (F3, 2026-10-05).
 *
 * What MatchTime switched on from the chat WhatsApp shared when it joined,
 * each with the chat evidence and a one-tap Undo; what it only suggests
 * (the weekly game, the language, and "organisers pick", which is never
 * switched from the chat: changed nowhere); and the patterns it noticed
 * and left alone (a monthly list). Renders nothing for a club that was
 * never read. The organiser's DM links here with
 * `?learned=<key>#learned-setup`, and that item is highlighted.
 *
 * THE SUGGESTIONS COME FIRST AND ARE LOUD (2026-10-12). They were a grey
 * bullet list under the switched settings and were easy to miss, and only
 * "organisers pick" had a link. When there is at least one, they are an
 * amber block above the switched settings: a warning icon, a heading that
 * counts them, and a card each with the messages behind it and a button
 * where Undo sits on a switched setting. Every kind has a button, going
 * where the DM's link for that kind goes (setup-learning/
 * suggestion-action.ts). With no suggestion the panel is as it was.
 *
 * The block is told apart from a deep-linked card, which is also amber,
 * by its left bar, icon and heading: the deep-linked card is one card
 * with a ring round it, and a suggestion that is deep-linked gets that
 * ring inside the block.
 *
 * After an Undo the page reloads, so every other section shows the
 * setting's new value from the server.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Sparkles } from "lucide-react";
import { getLearnedSetupAction, undoLearnedSettingAction } from "@/app/actions/setup-learning";
import { t } from "@/lib/i18n/t";
import { appliedLine, monthlyPattern, suggestionLine } from "@/lib/setup-learning/dm";
import { checkHeading, suggestionActionHref, suggestionActionLabel } from "@/lib/setup-learning/suggestion-action";
import type { LearnedSetupView } from "@/lib/setup-learning/view";

const ACTION_CLASS =
  "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";

/** WhatsApp bold (*x*) to plain text for the page. */
function plain(s: string): string {
  return s.replace(/\*([^*]+)\*/g, "$1");
}

export function LearnedSetupPanel(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const lang = props.language ?? "en";
  const [view, setView] = useState<LearnedSetupView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    getLearnedSetupAction(props.orgId)
      .then(setView)
      .catch(() => setView(null));
    if (typeof window !== "undefined") {
      const k = new URLSearchParams(window.location.search).get("learned");
      if (k) setHighlight(k);
    }
  }, [props.orgId]);

  useEffect(() => {
    if (!view || typeof document === "undefined") return;
    const target = document.getElementById(highlight ? `learned-${highlight}` : "learned-setup");
    if (target && (highlight || window.location.hash === "#learned-setup")) {
      target.scrollIntoView({ block: "center" });
    }
  }, [view, highlight]);

  if (!view) return null;

  async function undo(key: string) {
    setBusy(key);
    try {
      const r = await undoLearnedSettingAction(props.orgId, key);
      if (!r.ok) throw new Error(r.reason);
      toast.success(s.settings_learned_undone);
      window.location.reload();
    } catch {
      toast.error(s.settings_learned_undo_failed);
      setBusy(null);
    }
  }

  return (
    <section
      id="learned-setup"
      data-testid="learned-setup"
      className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6"
    >
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-800">{s.settings_learned_title}</h2>
      </div>
      <div className="p-6 space-y-4">
        {view.suggestions.length > 0 && (
          <section
            aria-labelledby="learned-check-heading"
            data-testid="learned-suggestions"
            className="rounded-lg border border-l-4 border-amber-300 border-l-amber-500 bg-amber-50 p-4"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="min-w-0">
                <h3 id="learned-check-heading" className="font-semibold text-amber-900">
                  {checkHeading(lang, view.suggestions.length)}
                </h3>
                <p className="text-sm text-amber-900">{s.settings_learned_check_sub}</p>
              </div>
            </div>
            <ul className="mt-3 space-y-3">
              {view.suggestions.map((sg) => {
                const href = suggestionActionHref(sg.key);
                const label = (
                  <>
                    {suggestionActionLabel(lang, sg.key)}
                    <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
                  </>
                );
                return (
                  <li
                    key={sg.key}
                    id={`learned-${sg.key}`}
                    data-testid={`learned-suggestion-${sg.key}`}
                    className={`rounded-lg border bg-white p-3 text-sm ${
                      highlight === sg.key ? "border-amber-500 ring-2 ring-amber-500" : "border-amber-200"
                    }`}
                  >
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
                      <div className="min-w-0 break-words">
                        <span data-testid="learned-suggestion-line" className="text-slate-800">
                          {suggestionLine(lang, sg)}
                        </span>
                        {sg.evidence.length > 0 && (
                          <p className="mt-1 text-slate-500">
                            {s.settings_learned_from}: {sg.evidence.map((q) => `"${q}"`).join(", ")}
                          </p>
                        )}
                      </div>
                      {href.startsWith("#") ? (
                        <a href={href} data-testid={`learned-action-${sg.key}`} className={ACTION_CLASS}>
                          {label}
                        </a>
                      ) : (
                        <Link href={href} data-testid={`learned-action-${sg.key}`} className={ACTION_CLASS}>
                          {label}
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <p className="text-sm text-slate-500">{s.settings_learned_lead}</p>

        {view.applied.length > 0 && (
          <ul className="space-y-3">
            {view.applied.map((a) => (
              <li
                key={a.key}
                id={`learned-${a.key}`}
                data-testid={`learned-item-${a.key}`}
                data-state={a.state}
                className={`rounded-lg border p-3 text-sm ${
                  highlight === a.key ? "border-amber-400 ring-2 ring-amber-300 bg-amber-50" : "border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className={a.state === "active" ? "text-slate-800" : "text-slate-400 line-through"}>
                    {plain(appliedLine(lang, a.key, a.to))}
                  </span>
                  {a.state === "active" ? (
                    <button
                      type="button"
                      data-testid={`learned-undo-${a.key}`}
                      disabled={busy !== null}
                      onClick={() => undo(a.key)}
                      className="h-9 px-3 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {s.settings_learned_undo}
                    </button>
                  ) : (
                    <span className="text-xs font-medium text-slate-500">
                      {a.state === "undone" ? s.settings_learned_undone : s.settings_learned_changed_since}
                    </span>
                  )}
                </div>
                {a.evidence.length > 0 && (
                  <p className="mt-1 text-slate-500">
                    {s.settings_learned_from}: {a.evidence.map((q) => `"${q}"`).join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {view.noted.length > 0 && (
          <div data-testid="learned-noted">
            <h3 className="text-sm font-medium text-slate-700">{s.settings_learned_noted_head}</h3>
            <ul className="mt-1 text-sm text-slate-600 space-y-1">
              {view.noted.map((n) => (
                <li key={n.key}>
                  {s.setup_monthly_label}: {monthlyPattern(lang, n)}.
                  {n.evidence.length > 0 && (
                    <span className="text-slate-500">
                      {" "}
                      {s.settings_learned_from}: {n.evidence.map((q) => `"${q}"`).join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
