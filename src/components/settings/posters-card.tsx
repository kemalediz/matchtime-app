"use client";

/**
 * THE POSTERS CARD on /admin/settings (2026-10-14).
 *
 * What MatchTime sends to the club's admin group before each match, ready
 * to forward: the list poster and the team sheet. The card shows both, for
 * the club's next match (or with marked sample names, "Player 1" to
 * "Player 18", until there are enough names), in the design in force, and
 * lets an owner or admin:
 *   - pick a design from a small gallery: the MatchTime design, the club's
 *     own design (made by MatchTime, or an uploaded background), and any
 *     design other clubs share (by display name, drawn with THIS club's
 *     name and players);
 *   - upload a portrait background picture, which MatchTime draws its own
 *     board over, and remove it again.
 *
 * Owner and admin only: the state comes from GET /api/org/graphics, which
 * answers 403 to anyone else, and then the card renders nothing. The
 * pictures are session-authenticated PNGs from /api/org/graphics/preview,
 * fetched again (`v`) after every change. Every word from the club's
 * language table, with its ⓘ.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t, type Strings } from "@/lib/i18n/t";

interface DesignOption {
  id: string;
  source: "matchtime" | "own" | "shared";
  kind: "measured" | "background" | null;
  label: string | null;
}

interface PostersState {
  current: string;
  options: DesignOption[];
  own: { kind: "measured" | "background" } | null;
  removable: boolean;
  sample: { list: boolean; teams: boolean };
}

type Notice = { tone: "ok" | "error"; text: string } | null;

const PROBLEM_KEYS = {
  empty: "gp_problem_empty",
  "too-large": "gp_problem_too_large",
  "bad-type": "gp_problem_bad_type",
  "bad-bytes": "gp_problem_bad_bytes",
  "too-small": "gp_problem_too_small",
  "not-portrait": "gp_problem_not_portrait",
  "made-by-matchtime": "gp_problem_made_by_matchtime",
  failed: "gp_problem_failed",
} as const satisfies Record<string, keyof Strings>;

function problemText(s: Strings, problem: unknown): string {
  const key = PROBLEM_KEYS[problem as keyof typeof PROBLEM_KEYS];
  return key ? s[key] : s.gp_problem_failed;
}

function optionName(s: Strings, o: DesignOption, sharedIndex: number): string {
  if (o.source === "matchtime") return s.gp_design_matchtime;
  if (o.source === "own") return o.kind === "background" ? s.gp_design_own_background : s.gp_design_own_measured;
  return o.label ?? s.gp_design_shared({ n: sharedIndex });
}

const previewUrl = (kind: "list" | "teams", v: number, design?: string) =>
  `/api/org/graphics/preview?kind=${kind}${design ? `&design=${encodeURIComponent(design)}` : ""}&v=${v}`;

function Preview({ src, alt, caption, testId, s }: { src: string; alt: string; caption: string; testId: string; s: Strings }) {
  // Keyed by `src` where it is used, so a new picture starts as "loading".
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <figure className="min-w-0">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          data-testid={testId}
          data-state={state}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          className="h-full w-full object-contain"
        />
        {state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-slate-500">
            {state === "loading" ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                {s.gp_preview_loading}
              </span>
            ) : (
              s.gp_preview_failed
            )}
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 text-sm font-medium text-slate-700">{caption}</figcaption>
    </figure>
  );
}

export function PostersCard(props: { club: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [state, setState] = useState<PostersState | null>(null);
  const [v, setV] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/org/graphics", { cache: "no-store" });
    if (!res.ok) {
      setState(null);
      return;
    }
    setState((await res.json()) as PostersState);
    setV(Date.now());
  }, []);

  useEffect(() => {
    load().catch(() => setState(null));
  }, [load]);

  if (!state) return null;

  async function run(what: string, fn: () => Promise<Notice>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(what);
    setNotice(null);
    try {
      const n = await fn();
      await load().catch(() => {});
      setNotice(n);
    } catch {
      setNotice({ tone: "error", text: s.gp_problem_failed });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const choose = (id: string) =>
    run(`design:${id}`, async () => {
      const res = await fetch("/api/org/graphics/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design: id }),
      });
      return res.ok ? { tone: "ok", text: s.gp_saved } : { tone: "error", text: s.gp_save_failed };
    });

  const upload = (file: File) =>
    run("upload", async () => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/org/graphics/background", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; problem?: string } | null;
      return res.ok && body?.ok ? { tone: "ok", text: s.gp_uploaded } : { tone: "error", text: problemText(s, body?.problem ?? (res.status === 413 ? "too-large" : "failed")) };
    });

  const remove = () =>
    run("remove", async () => {
      const res = await fetch("/api/org/graphics/background", { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; problem?: string } | null;
      return res.ok ? { tone: "ok", text: s.gp_removed } : { tone: "error", text: problemText(s, body?.problem) };
    });

  let sharedSeen = 0;
  const named = state.options.map((o) => ({ o, name: optionName(s, o, o.source === "shared" ? ++sharedSeen : 0) }));
  const sample = state.sample.list || state.sample.teams;
  const ownIsUpload = state.own?.kind === "background";
  const ownIsMeasured = state.own?.kind === "measured";

  return (
    <section
      id="posters"
      aria-labelledby="posters-heading"
      data-testid="posters-card"
      data-setting="posters"
      lang={props.language ?? undefined}
      className="scroll-mt-6 bg-white rounded-xl border border-slate-200 shadow-sm"
    >
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <ImageIcon aria-hidden="true" className="w-4 h-4 text-slate-500" />
        <h2 id="posters-heading" className="font-semibold text-slate-800">
          {s.gp_title}
        </h2>
        <SettingInfo k="posters" lang={props.language} />
      </div>

      <div className="p-4 sm:p-6 space-y-5 min-w-0">
        <p className="text-sm text-slate-500">{s.gp_lead}</p>

        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <Preview key={`list-${v}`} src={previewUrl("list", v)} alt={s.gp_alt_list({ club: props.club })} caption={s.gp_list_caption} testId="poster-preview-list" s={s} />
          <Preview key={`teams-${v}`} src={previewUrl("teams", v)} alt={s.gp_alt_teams({ club: props.club })} caption={s.gp_teams_caption} testId="poster-preview-teams" s={s} />
        </div>
        {sample && (
          <p data-testid="posters-sample" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {s.gp_sample_note}
          </p>
        )}

        <div data-setting="posterDesign">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-semibold text-slate-800">{s.gp_design_heading}</h3>
            <SettingInfo k="posterDesign" lang={props.language} />
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="posters-gallery">
            {named.map(({ o, name }) => {
              const inUse = state.current === o.id;
              return (
                <li key={o.id} className="min-w-0">
                  <button
                    type="button"
                    data-testid={`poster-design-${o.id}`}
                    aria-pressed={inUse}
                    aria-label={s.gp_use_label({ name })}
                    disabled={busy !== null}
                    onClick={() => !inUse && choose(o.id)}
                    className={`w-full rounded-lg border p-1.5 text-left transition-colors disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                      inUse ? "border-blue-600 ring-2 ring-blue-600 bg-blue-50" : "border-slate-200 hover:border-slate-400 bg-white"
                    }`}
                  >
                    <div className="aspect-[4/5] w-full overflow-hidden rounded bg-slate-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={previewUrl("list", v, o.id)} alt="" loading="lazy" className="h-full w-full object-contain" />
                    </div>
                    <span className="mt-1.5 block text-xs font-medium text-slate-800 [overflow-wrap:anywhere]">{name}</span>
                    {inUse && (
                      <span data-testid="poster-design-in-use" className="mt-1 inline-block rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white">
                        {s.gp_design_in_use}
                      </span>
                    )}
                    {busy === `design:${o.id}` && <Loader2 aria-hidden="true" className="mt-1 h-4 w-4 animate-spin text-slate-500" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {!ownIsMeasured && (
          <div data-setting="posterBackground">
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-semibold text-slate-800">{s.gp_upload_heading}</h3>
              <SettingInfo k="posterBackground" lang={props.language} />
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{s.gp_upload_blurb}</p>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              data-testid="posters-upload-input"
              aria-label={ownIsUpload ? s.gp_upload_replace : s.gp_upload_button}
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) upload(f);
              }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="posters-upload"
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
              >
                {busy === "upload" ? <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" /> : <Upload aria-hidden="true" className="w-4 h-4" />}
                {busy === "upload" ? s.gp_uploading : ownIsUpload ? s.gp_upload_replace : s.gp_upload_button}
              </button>
              {state.removable && (
                <button
                  type="button"
                  data-testid="posters-remove"
                  disabled={busy !== null}
                  onClick={remove}
                  className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-700 hover:text-red-700 font-medium disabled:opacity-50"
                >
                  {busy === "remove" ? <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" /> : <Trash2 aria-hidden="true" className="w-4 h-4" />}
                  {busy === "remove" ? s.gp_removing : s.gp_remove}
                </button>
              )}
            </div>
          </div>
        )}

        <div role="status" aria-live="polite" data-testid="posters-status" className="min-w-0">
          {notice && (
            <p
              data-testid={notice.tone === "ok" ? "posters-ok" : "posters-error"}
              className={`rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere] ${
                notice.tone === "ok" ? "border border-emerald-200 bg-emerald-50 text-emerald-900" : "border border-red-200 bg-red-50 text-red-800"
              }`}
            >
              {notice.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
