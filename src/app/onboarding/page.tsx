"use client";

/**
 * Onboarding wizard.
 *
 * Walks a new admin through creating their organisation from a WhatsApp
 * chat export. Four steps:
 *
 *   1. Upload .txt and show what we detected (org name, date range, count)
 *   2. Review / edit the player list
 *   3. Set up the activity (sport + schedule + venue)
 *   4. Confirm & create
 *
 * All state lives in this component — no server session between steps.
 * We commit everything at once in step 4 to keep the DB transactional.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  parseChatUpload,
  analyzeOnboardingChat,
  createOrgFromWizard,
  type ParsedChatSummary,
  type WizardSubmission,
} from "@/app/actions/onboarding";
import type { OnboardingAnalysis } from "@/lib/onboarding-analyzer";
import { SPORT_PRESETS, findPreset } from "@/lib/sport-presets";
import {
  Upload,
  Users,
  Calendar,
  Check,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Trash2,
  X,
  Sparkles,
  Quote,
} from "lucide-react";

type Step = "upload" | "players" | "insights" | "activity" | "confirm";

interface PlayerDraft {
  name: string;
  phone: string;
  seedRating: number | null;
  excluded: boolean; // admin toggled "not a player"
  isLikelyMe?: boolean; // server pre-flagged this row as the current admin
}

export default function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);

  const [parsed, setParsed] = useState<ParsedChatSummary | null>(null);
  // Kept client-side only so we can rerun the LLM analysis on demand
  // without re-uploading. Never leaves this component.
  const [chatText, setChatText] = useState<string>("");
  const [orgName, setOrgName] = useState("");
  const [players, setPlayers] = useState<PlayerDraft[]>([]);
  const [analysis, setAnalysis] = useState<OnboardingAnalysis | null>(null);
  const [analysisSkipped, setAnalysisSkipped] = useState(false);
  const [paymentHolderName, setPaymentHolderName] = useState<string>("");
  const [activity, setActivity] = useState<WizardSubmission["activity"]>({
    sportKey: "football-7aside",
    name: "",
    dayOfWeek: 2, // Tuesday
    time: "21:30",
    venue: "",
    matchDurationMins: 60,
  });

  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const summary = await parseChatUpload(text);
      setParsed(summary);
      setChatText(text);
      setOrgName(summary.groupName ?? guessNameFromFilename(file.name) ?? "");
      // Seed the player list from detected authors.
      // Authors flagged as `isLikelyMe` are pre-excluded — the admin
      // already gets an OWNER membership and shouldn't duplicate as a
      // PLAYER. They can untick the X to include themselves if they
      // do play.
      setPlayers(
        summary.authors.map((a) => ({
          name: a.name,
          phone: a.phone ?? "",
          seedRating: null,
          excluded: a.isLikelyMe,
          isLikelyMe: a.isLikelyMe,
        })),
      );
      setActivity((a) => ({
        ...a,
        name: summary.groupName ?? a.name,
      }));
      setStep("players");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysis() {
    if (!chatText) {
      toast.error("No chat loaded");
      return;
    }
    setBusy(true);
    try {
      const active = players.filter((p) => !p.excluded && p.name.trim());
      const result = await analyzeOnboardingChat(
        chatText,
        activity.sportKey,
        active.map((p) => p.name),
      );
      if (!result) {
        toast.error("Analysis failed, but you can still continue with defaults.");
        setAnalysisSkipped(true);
      } else {
        setAnalysis(result);
        // Pre-fill schedule + seed ratings from the LLM suggestions.
        if (result.schedule.dayOfWeek != null)
          setActivity((a) => ({ ...a, dayOfWeek: result.schedule.dayOfWeek! }));
        if (result.schedule.time) setActivity((a) => ({ ...a, time: result.schedule.time! }));
        if (result.schedule.venue && !activity.venue)
          setActivity((a) => ({ ...a, venue: result.schedule.venue! }));
        // Payment holder — auto-apply when LLM is confident enough.
        if (result.paymentHolder.name && result.paymentHolder.confidence >= 0.5) {
          setPaymentHolderName(result.paymentHolder.name);
        }
        // Apply LLM-suggested seed ratings where the admin hasn't set one.
        setPlayers((prev) =>
          prev.map((p) => {
            if (p.excluded || !p.name.trim()) return p;
            const suggestion = result.players.find(
              (sp) => sp.name.toLowerCase() === p.name.toLowerCase(),
            );
            if (!suggestion) return p;
            return {
              ...p,
              seedRating: p.seedRating ?? suggestion.seedRating ?? null,
            };
          }),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Analysis failed");
      setAnalysisSkipped(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    setBusy(true);
    try {
      const active = players.filter((p) => !p.excluded && p.name.trim());
      const res = await createOrgFromWizard({
        orgName,
        paymentHolderName: paymentHolderName.trim() || undefined,
        players: active.map((p) => ({
          name: p.name.trim(),
          phone: p.phone.trim() || undefined,
          seedRating: p.seedRating ?? undefined,
        })),
        activity,
      });
      toast.success(
        `Created ${res.slug}. ${res.playersCreated} new, ${res.playersLinkedExisting} linked.`,
      );
      router.push("/admin");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900">Set up your group</h1>
          <p className="text-slate-500 mt-1.5">
            We&apos;ll read your chat history, detect your players, and get
            you ready for your first match in a few minutes.
          </p>
        </div>

        <Stepper current={step} />

        <div className="mt-8">
          {step === "upload" && <UploadStep busy={busy} onFile={handleUpload} />}
          {step === "players" && (
            <PlayersStep
              busy={busy}
              parsed={parsed}
              orgName={orgName}
              setOrgName={setOrgName}
              players={players}
              setPlayers={setPlayers}
              onBack={() => setStep("upload")}
              onNext={() => setStep("insights")}
            />
          )}
          {step === "insights" && (
            <InsightsStep
              busy={busy}
              analysis={analysis}
              analysisSkipped={analysisSkipped}
              players={players}
              setPlayers={setPlayers}
              sportKey={activity.sportKey}
              paymentHolderName={paymentHolderName}
              setPaymentHolderName={setPaymentHolderName}
              onRun={runAnalysis}
              onSkip={() => {
                setAnalysisSkipped(true);
                setStep("activity");
              }}
              onBack={() => setStep("players")}
              onNext={() => setStep("activity")}
            />
          )}
          {step === "activity" && (
            <ActivityStep
              busy={busy}
              activity={activity}
              setActivity={setActivity}
              onBack={() => setStep("players")}
              onNext={() => setStep("confirm")}
            />
          )}
          {step === "confirm" && (
            <ConfirmStep
              busy={busy}
              orgName={orgName}
              players={players.filter((p) => !p.excluded && p.name.trim())}
              activity={activity}
              onBack={() => setStep("activity")}
              onCommit={handleCommit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step shell ──────────────────────────────────────────────────────

function Stepper({ current }: { current: Step }) {
  const steps: Array<{ key: Step; label: string; icon: React.ReactNode }> = [
    { key: "upload", label: "Upload", icon: <Upload className="w-4 h-4" /> },
    { key: "players", label: "Players", icon: <Users className="w-4 h-4" /> },
    { key: "insights", label: "Insights", icon: <Sparkles className="w-4 h-4" /> },
    { key: "activity", label: "Schedule", icon: <Calendar className="w-4 h-4" /> },
    { key: "confirm", label: "Confirm", icon: <Check className="w-4 h-4" /> },
  ];
  const currentIdx = steps.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <li key={s.key} className="flex-1 flex items-center gap-2">
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600 text-white"
                  : done
                  ? "bg-blue-50 text-blue-700"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {done ? <Check className="w-4 h-4" /> : s.icon}
              <span className="hidden sm:inline">{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px ${done ? "bg-blue-300" : "bg-slate-200"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Step 1: upload ──────────────────────────────────────────────────

function UploadStep({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-8">
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Upload your WhatsApp chat export
      </h2>
      <p className="text-sm text-slate-500 mb-6">
        In WhatsApp, open your group → group info → <em>Export chat</em> →{" "}
        <em>Without media</em>. You&apos;ll get a <code className="text-xs px-1 rounded bg-slate-100">.txt</code>{" "}
        file. Drop it here.
      </p>

      <label
        className={`block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          busy ? "border-slate-200 bg-slate-50" : "border-slate-300 hover:border-blue-400 hover:bg-blue-50/40"
        }`}
      >
        <input
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
        />
        {busy ? (
          <div className="flex items-center justify-center gap-2 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Reading your chat…</span>
          </div>
        ) : (
          <>
            <Upload className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <p className="font-medium text-slate-700">Click to choose a .txt file</p>
            <p className="text-xs text-slate-500 mt-1">Up to 5MB (2 years of chat fits easily)</p>
          </>
        )}
      </label>

      <p className="text-xs text-slate-400 mt-4">
        Privacy: your chat is read once to detect players, then discarded.
        We don&apos;t store message content.
      </p>
    </div>
  );
}

// ─── Step 2: players ─────────────────────────────────────────────────

function PlayersStep(props: {
  busy: boolean;
  parsed: ParsedChatSummary | null;
  orgName: string;
  setOrgName: (s: string) => void;
  players: PlayerDraft[];
  setPlayers: React.Dispatch<React.SetStateAction<PlayerDraft[]>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const { parsed, orgName, setOrgName, players, setPlayers, onBack, onNext } = props;

  function updatePlayer(idx: number, patch: Partial<PlayerDraft>) {
    setPlayers((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addPlayer() {
    setPlayers((prev) => [
      ...prev,
      { name: "", phone: "", seedRating: null, excluded: false },
    ]);
  }
  function toggleExclude(idx: number) {
    setPlayers((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, excluded: !p.excluded } : p)),
    );
  }

  const activeCount = players.filter((p) => !p.excluded && p.name.trim()).length;

  // Flag duplicate names across active (non-excluded) rows so the admin
  // notices and disambiguates them before commit. Two "Ibrahim"s with no
  // phone will confuse the live matcher later.
  const nameCounts = new Map<string, number>();
  for (const p of players) {
    if (p.excluded || !p.name.trim()) continue;
    const k = p.name.trim().toLowerCase();
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }
  const duplicateNames = new Set(
    [...nameCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
  );

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <label className="block text-sm font-semibold text-slate-700 mb-2">
          Group name
        </label>
        <input
          type="text"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="Sutton FC"
          className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {parsed && (
          <p className="text-xs text-slate-500 mt-2">
            Read {parsed.totalMessages.toLocaleString()} messages
            {parsed.firstMessageAt && parsed.lastMessageAt && (
              <>
                {" "}from{" "}
                <strong>{new Date(parsed.firstMessageAt).toLocaleDateString()}</strong>{" "}
                to{" "}
                <strong>{new Date(parsed.lastMessageAt).toLocaleDateString()}</strong>
              </>
            )}
            . Found {parsed.authors.length} people.
          </p>
        )}
      </div>

      {duplicateNames.size > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          <p className="font-medium mb-1">
            ⚠️ Two or more players share the same name
          </p>
          <p className="text-amber-800/90">
            Rename one (e.g. &quot;Ibrahim S.&quot; vs &quot;Ibrahim M.&quot;)
            or add their phone number so MatchTime can tell them apart
            later. Without disambiguation, &quot;Ibrahim is in&quot; in
            the chat would be ambiguous and skipped.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="font-semibold text-slate-900">Players</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {activeCount} active · Toggle ✕ to exclude bots or non-players
            </p>
          </div>
          <button
            onClick={addPlayer}
            className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            + Add player
          </button>
        </div>
        <div className="divide-y divide-slate-100">
          {players.map((p, i) => {
            const isDup =
              !p.excluded &&
              p.name.trim() &&
              duplicateNames.has(p.name.trim().toLowerCase());
            return (
            <div
              key={i}
              className={`grid grid-cols-1 sm:grid-cols-[1fr_160px_90px_auto] gap-3 px-6 py-3 items-center ${
                p.excluded ? "opacity-50 bg-slate-50" : isDup ? "bg-amber-50/60" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={p.name}
                  placeholder="Name"
                  onChange={(e) => updatePlayer(i, { name: e.target.value })}
                  className={`flex-1 h-9 px-2.5 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    isDup ? "border-amber-300" : "border-slate-200"
                  }`}
                />
                {p.isLikelyMe && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-200 whitespace-nowrap"
                    title="This looks like you. Excluded by default. Toggle ✓ if you also play."
                  >
                    you
                  </span>
                )}
              </div>
              <input
                type="tel"
                value={p.phone}
                placeholder="Phone (optional)"
                onChange={(e) => updatePlayer(i, { phone: e.target.value })}
                className="h-9 px-2.5 rounded-md border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                value={p.seedRating ?? ""}
                placeholder="1-10"
                title="Seed rating (optional, 1-10)"
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  updatePlayer(i, { seedRating: isNaN(n) ? null : Math.min(10, Math.max(1, n)) });
                }}
                className="h-9 px-2 rounded-md border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => toggleExclude(i)}
                title={p.excluded ? "Include" : "Exclude"}
                className="h-9 w-9 rounded-md border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-50"
              >
                {p.excluded ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
              </button>
            </div>
            );
          })}
          {players.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-slate-400">
              No players detected. Add them manually.
            </div>
          )}
        </div>
      </div>

      <WizardNav
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!orgName.trim() || activeCount === 0}
      />
    </div>
  );
}

// ─── Step 3: insights (LLM-assisted) ─────────────────────────────────

function InsightsStep(props: {
  busy: boolean;
  analysis: OnboardingAnalysis | null;
  analysisSkipped: boolean;
  players: PlayerDraft[];
  setPlayers: React.Dispatch<React.SetStateAction<PlayerDraft[]>>;
  sportKey: string;
  paymentHolderName: string;
  setPaymentHolderName: (s: string) => void;
  onRun: () => void;
  onSkip: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const {
    busy,
    analysis,
    players,
    setPlayers,
    sportKey,
    paymentHolderName,
    setPaymentHolderName,
    onRun,
    onSkip,
    onBack,
    onNext,
  } = props;
  const preset = findPreset(sportKey);
  const validPositions = preset?.positions ?? [];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const hasAnalysis = !!analysis;

  function updateRating(idx: number, value: number | null) {
    setPlayers((prev) => prev.map((p, i) => (i === idx ? { ...p, seedRating: value } : p)));
  }

  if (!hasAnalysis) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-blue-100 mx-auto flex items-center justify-center mb-4">
            <Sparkles className="w-5 h-5 text-blue-600" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            Let MatchTime read your chat
          </h2>
          <p className="text-sm text-slate-500 max-w-md mx-auto mb-6">
            Optional. Analyses the messages to suggest each player&apos;s
            position and skill rating, plus your likely match day/time/venue.
            Takes ~15-30 seconds. You can edit everything after.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={onSkip}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Skip
            </button>
            <button
              onClick={onRun}
              disabled={busy}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-40"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analysing…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Analyse chat
                </>
              )}
            </button>
          </div>
        </div>
        <WizardNav onBack={onBack} onNext={onNext} />
      </div>
    );
  }

  // Analysis loaded.
  const schedule = analysis!.schedule;
  const playerSuggestions = new Map(
    analysis!.players.map((p) => [p.name.toLowerCase(), p]),
  );

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-blue-600" />
          <h2 className="font-semibold text-slate-900">Suggested schedule</h2>
          {schedule.confidence > 0 && (
            <span className="text-xs text-slate-400">
              · {Math.round(schedule.confidence * 100)}% confident
            </span>
          )}
        </div>
        {schedule.dayOfWeek != null || schedule.time || schedule.venue ? (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-slate-500 mb-0.5">Day</p>
              <p className="font-medium">
                {schedule.dayOfWeek != null ? days[schedule.dayOfWeek] : "-"}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-0.5">Kickoff</p>
              <p className="font-medium">{schedule.time ?? "-"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-0.5">Venue</p>
              <p className="font-medium truncate">{schedule.venue ?? "-"}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No clear match pattern detected. Set it manually on the next step.
          </p>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-blue-600" />
          <h2 className="font-semibold text-slate-900">Payment holder</h2>
          {analysis!.paymentHolder.confidence > 0 && (
            <span className="text-xs text-slate-400">
              · {Math.round(analysis!.paymentHolder.confidence * 100)}% confident
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          The player who collects pitch fees from everyone else. They
          won&apos;t be chased in the &quot;who hasn&apos;t paid&quot; reminder.
        </p>
        <select
          value={paymentHolderName}
          onChange={(e) => setPaymentHolderName(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Not set (nobody excluded)</option>
          {players
            .filter((p) => !p.excluded && p.name.trim())
            .map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
        </select>
        {analysis!.paymentHolder.evidence && (
          <div className="flex items-start gap-2 text-xs text-slate-500 mt-3">
            <Quote className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-300" />
            <p className="italic leading-relaxed">{analysis!.paymentHolder.evidence}</p>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Suggested positions &amp; ratings</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Click a position to change it. Adjust ratings inline. Evidence
            quotes help you sanity-check.
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {players
            .filter((p) => !p.excluded && p.name.trim())
            .map((p) => {
              const idx = players.indexOf(p);
              const sug = playerSuggestions.get(p.name.toLowerCase());
              const rating = p.seedRating ?? sug?.seedRating ?? null;
              return (
                <div key={p.name} className="px-6 py-4 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-slate-800 truncate">{p.name}</p>
                    <div className="flex items-center gap-3 shrink-0">
                      {sug?.position && validPositions.length > 0 && (
                        <span className="inline-flex px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-semibold">
                          {sug.position}
                        </span>
                      )}
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-slate-500">Rating</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          step={1}
                          value={rating ?? ""}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            updateRating(idx, isNaN(n) ? null : Math.min(10, Math.max(1, n)));
                          }}
                          className="w-14 h-8 px-1.5 rounded-md border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      {sug && sug.confidence > 0 && (
                        <span className="text-[10px] text-slate-400 tabular-nums">
                          {Math.round(sug.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                  {sug?.evidence && (
                    <div className="flex items-start gap-2 text-xs text-slate-500">
                      <Quote className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-300" />
                      <p className="italic leading-relaxed">{sug.evidence}</p>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <WizardNav onBack={onBack} onNext={onNext} />
    </div>
  );
}

// ─── Step 4: activity ────────────────────────────────────────────────

function ActivityStep(props: {
  busy: boolean;
  activity: WizardSubmission["activity"];
  setActivity: React.Dispatch<React.SetStateAction<WizardSubmission["activity"]>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const { activity, setActivity, onBack, onNext } = props;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const update = (patch: Partial<WizardSubmission["activity"]>) =>
    setActivity((a) => ({ ...a, ...patch }));

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Sport</label>
          <select
            value={activity.sportKey}
            onChange={(e) => update({ sportKey: e.target.value })}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SPORT_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.playersPerTeam * 2} players)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Activity name</label>
          <input
            type="text"
            value={activity.name}
            placeholder="Tuesday 7-a-side"
            onChange={(e) => update({ name: e.target.value })}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1.5">
            Shown in the group chat and the admin panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Day of week</label>
            <select
              value={activity.dayOfWeek}
              onChange={(e) => update({ dayOfWeek: parseInt(e.target.value, 10) })}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {days.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Kickoff time</label>
            <input
              type="time"
              value={activity.time}
              onChange={(e) => update({ time: e.target.value })}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Venue</label>
          <input
            type="text"
            value={activity.venue}
            placeholder="Goals Sutton"
            onChange={(e) => update({ venue: e.target.value })}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            Match duration (minutes)
          </label>
          <input
            type="number"
            min={10}
            max={240}
            value={activity.matchDurationMins}
            onChange={(e) => update({ matchDurationMins: parseInt(e.target.value, 10) || 60 })}
            className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <WizardNav
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!activity.name.trim() || !activity.venue.trim() || !activity.time}
      />
    </div>
  );
}

// ─── Step 4: confirm ─────────────────────────────────────────────────

function ConfirmStep(props: {
  busy: boolean;
  orgName: string;
  players: PlayerDraft[];
  activity: WizardSubmission["activity"];
  onBack: () => void;
  onCommit: () => void;
}) {
  const { busy, orgName, players, activity, onBack, onCommit } = props;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const withPhone = players.filter((p) => p.phone.trim()).length;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
        <Line label="Organisation" value={orgName} />
        <Line label="Activity" value={`${activity.name}, ${days[activity.dayOfWeek]} ${activity.time}`} />
        <Line label="Venue" value={activity.venue} />
        <Line label="Players" value={`${players.length} (${withPhone} with phone)`} />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
        <p className="font-medium mb-1">You can change everything after this.</p>
        <p className="text-blue-800/80">
          Venue, schedule, player phones, seed ratings: all editable from
          your admin panel. Hitting Create just sets up the scaffolding so
          your next match can be scheduled.
        </p>
      </div>

      <WizardNav
        onBack={onBack}
        onNext={onCommit}
        busy={busy}
        nextLabel="Create organisation"
      />
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-900">{value || "-"}</span>
    </div>
  );
}

function WizardNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = "Next",
  busy,
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <button
        onClick={onBack}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <button
        onClick={onNext}
        disabled={busy || nextDisabled}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-40"
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Working…
          </>
        ) : (
          <>
            {nextLabel}
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function guessNameFromFilename(filename: string): string | null {
  // "WhatsApp Chat with Sutton FC.txt" → "Sutton FC"
  const m =
    filename.match(/WhatsApp\s*Chat\s*with\s*(.+?)(?:\.txt)?$/i) ??
    filename.match(/_chat\.txt$/i);
  if (m?.[1]) return m[1].trim();
  return null;
}
