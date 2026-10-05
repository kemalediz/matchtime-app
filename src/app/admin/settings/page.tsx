"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Link as LinkIcon, Users, Settings, MessageCircle, SlidersHorizontal, Landmark, CheckCircle2, Shirt, Languages, Repeat } from "lucide-react";
import { setOrgFeature, setOrgLanguage, setOrgTeamLabels, setWeeklyRoutine } from "@/app/actions/org";
import { InfoButton } from "@/components/stats/info-button";
import { WeeklyDeadlineRows, type DayTimeValue } from "@/components/settings/weekly-deadline-rows";
import { t } from "@/lib/i18n/t";
import { startCollectorOnboarding, refreshCollectorStatus, resetCollectorConnect, openCollectorDashboard, setPaymentHolder } from "@/app/actions/payments";
import { FEATURE_META, type ToggleableKey } from "@/lib/org-features-meta";
import { LANGS, LANG_LABELS, normaliseLang, type Lang } from "@/lib/i18n/lang";
import { AdminChannelSettings } from "@/components/settings/admin-channel-section";
import { PickModeRows } from "@/components/settings/pick-mode-rows";
import { BillingSettingsCard, type BillingCardData } from "@/components/settings/billing-card";
import { SectionInfo } from "@/components/info/section-info";
import { FEATURE_INFO } from "@/lib/info-copy";

type FeatureKey = ToggleableKey;

interface OrgData {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  memberCount: number;
  /** Org-level team-name override (raw — [] or empty strings = defaults). */
  teamLabels?: string[];
  /** What the labels resolve to when no override is set (sport defaults). */
  defaultTeamLabels?: [string, string];
  /** The language the bot speaks to this group in ("en" | "tr"). */
  language?: string;
  features: Record<FeatureKey, boolean>;
  stripeConnected?: boolean;
  stripeChargesEnabled?: boolean;
  paymentHolderId?: string | null;
  members?: { id: string; name: string | null }[];
  /** "Weekly routine" (2026-09-30). Slices 2 and 3 add their settings. */
  weeklyRoutine?: {
    rollingSquad: boolean;
    /** Weekly deadlines (slice 3): null when not set. */
    dropOutDeadline?: DayTimeValue | null;
    listPublish?: DayTimeValue | null;
    /** Organiser pick (slice 2b). */
    benchPickMode?: "first-come" | "organiser";
    benchPickFallback?: "bench-offer" | "leave-empty";
  };
  /** Club fee billing (slice B2): null or absent with billing off and for
   *  an exempt club, so nothing new shows. */
  billing?: BillingCardData | null;
}

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        setOrg(data);
        setTeamRed(data?.teamLabels?.[0] ?? "");
        setTeamYellow(data?.teamLabels?.[1] ?? "");
        // Returning from Stripe onboarding (?stripe=done|refresh) → auto
        // re-check charges-enabled so the collector doesn't have to hit
        // "Refresh status" and wonder why it still says "Finish setup".
        if (
          data?.id &&
          typeof window !== "undefined" &&
          /[?&]stripe=(done|refresh)/.test(window.location.search)
        ) {
          try {
            const { chargesEnabled } = await refreshCollectorStatus(data.id);
            setOrg((prev) =>
              prev ? { ...prev, stripeChargesEnabled: chargesEnabled, stripeConnected: true } : prev,
            );
            if (chargesEnabled) toast.success("Bank connected — ready to take payments");
          } catch {
            /* non-fatal — the "Refresh status" button is the fallback */
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function copyInviteLink() {
    if (!org) return;
    const link = `${window.location.origin}/join/${org.inviteCode}`;
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied!");
  }

  // Team names — controlled inputs holding the org OVERRIDE (empty =
  // fall back to the sport defaults shown as placeholders).
  const [teamRed, setTeamRed] = useState("");
  const [teamYellow, setTeamYellow] = useState("");
  const [savingTeamLabels, setSavingTeamLabels] = useState(false);
  async function saveTeamLabels() {
    if (!org) return;
    setSavingTeamLabels(true);
    try {
      const { teamLabels } = await setOrgTeamLabels(org.id, teamRed, teamYellow);
      setOrg((prev) => (prev ? { ...prev, teamLabels } : prev));
      setTeamRed(teamLabels[0] ?? "");
      setTeamYellow(teamLabels[1] ?? "");
      toast.success(
        teamLabels.length
          ? `Teams will be called ${teamLabels[0] || org.defaultTeamLabels?.[0] || "Red"} and ${teamLabels[1] || org.defaultTeamLabels?.[1] || "Yellow"}`
          : "Back to the default team names",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save team names");
    } finally {
      setSavingTeamLabels(false);
    }
  }

  // Bot language. Saved on change; the select is the whole form.
  const [savingLanguage, setSavingLanguage] = useState(false);
  async function saveLanguage(next: Lang) {
    if (!org) return;
    setSavingLanguage(true);
    try {
      const { language } = await setOrgLanguage(org.id, next);
      setOrg((prev) => (prev ? { ...prev, language } : prev));
      toast.success(`MatchTime will speak ${LANG_LABELS[normaliseLang(language)]} in this group`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the language");
    } finally {
      setSavingLanguage(false);
    }
  }

  const [savingFeature, setSavingFeature] = useState<string | null>(null);
  async function toggleFeature(key: FeatureKey, next: boolean) {
    if (!org) return;
    setSavingFeature(key);
    // Optimistic — flip locally so the switch responds instantly.
    setOrg((prev) =>
      prev ? { ...prev, features: { ...prev.features, [key]: next } } : prev,
    );
    try {
      await setOrgFeature(org.id, key, next);
      toast.success(`${next ? "Enabled" : "Disabled"} ${key}`);
    } catch (e) {
      // Roll back on failure.
      setOrg((prev) =>
        prev ? { ...prev, features: { ...prev.features, [key]: !next } } : prev,
      );
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSavingFeature(null);
    }
  }

  // Weekly routine (2026-09-30). One switch per setting, saved on change
  // through the one `setWeeklyRoutine` action.
  const [savingRoutine, setSavingRoutine] = useState<string | null>(null);
  async function toggleRollingSquad(next: boolean) {
    if (!org) return;
    const s = t(org.language);
    setSavingRoutine("rollingSquad");
    setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad: next } } : prev));
    try {
      const res = await setWeeklyRoutine(org.id, { rollingSquad: next });
      if (!res.ok) throw new Error(res.error);
      const { rollingSquad } = res;
      setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad } } : prev));
      toast.success(rollingSquad ? s.wr_rolling_on : s.wr_rolling_off);
    } catch {
      setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad: !next } } : prev));
      toast.error(s.wr_save_failed);
    } finally {
      setSavingRoutine(null);
    }
  }

  const [savingHolder, setSavingHolder] = useState(false);
  async function changeHolder(userId: string) {
    if (!org || !userId) return;
    const prevId = org.paymentHolderId ?? null;
    setSavingHolder(true);
    setOrg((prev) => (prev ? { ...prev, paymentHolderId: userId } : prev)); // optimistic
    try {
      const { name } = await setPaymentHolder(org.id, userId);
      toast.success(`Money collector set to ${name ?? "that member"}`);
    } catch (e) {
      setOrg((prev) => (prev ? { ...prev, paymentHolderId: prevId } : prev)); // roll back
      toast.error(e instanceof Error ? e.message : "Couldn't change collector");
    } finally {
      setSavingHolder(false);
    }
  }

  const [connecting, setConnecting] = useState(false);
  async function connectBank() {
    if (!org) return;
    setConnecting(true);
    try {
      const { url } = await startCollectorOnboarding(org.id);
      window.location.href = url; // Stripe-hosted onboarding
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start bank connect");
      setConnecting(false);
    }
  }
  async function refreshBank() {
    if (!org) return;
    try {
      const { chargesEnabled } = await refreshCollectorStatus(org.id);
      setOrg((prev) => (prev ? { ...prev, stripeChargesEnabled: chargesEnabled, stripeConnected: true } : prev));
      toast.success(chargesEnabled ? "Bank connected — ready to take payments" : "Onboarding not finished yet");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't refresh");
    }
  }
  async function manageBank() {
    if (!org) return;
    try {
      const { url } = await openCollectorDashboard(org.id);
      window.open(url, "_blank", "noopener,noreferrer"); // Stripe Express dashboard
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open the bank dashboard");
    }
  }
  const [resetting, setResetting] = useState(false);
  async function resetBank() {
    if (!org) return;
    if (
      !confirm(
        "Disconnect the current Stripe account so you can connect a fresh one?\n\nThis only clears the link in MatchTime — it won't affect any payments already taken. You'll need to complete bank setup again.",
      )
    )
      return;
    setResetting(true);
    try {
      await resetCollectorConnect(org.id);
      setOrg((prev) => (prev ? { ...prev, stripeConnected: false, stripeChargesEnabled: false } : prev));
      toast.success("Disconnected — tap “Connect bank” to set up a fresh account");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't reset");
    } finally {
      setResetting(false);
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;
  if (!org) return <div className="p-10 text-center text-slate-400">Organisation not found.</div>;

  const inviteLink = `${typeof window !== "undefined" ? window.location.origin : ""}/join/${org.inviteCode}`;

  return (
    <div className="space-y-6">
      {/* General */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <Settings className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">General</h2>
          <SectionInfo k="st_general" lang={org.language} />
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Organisation name
            </label>
            <input
              value={org.name}
              disabled
              className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">URL slug</label>
            <input
              value={org.slug}
              disabled
              className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
            />
          </div>
          <div className="flex items-center gap-1.5 text-sm text-slate-500">
            <Users className="w-4 h-4" />
            {org.memberCount} members
          </div>
        </div>
      </section>

      {/* Team names */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <Shirt className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Team names</h2>
          <SectionInfo k="st_team_names" lang={org.language} />
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-500">
            What the two sides are called in lineups, score messages and match
            pages. Leave a field empty to use the default
            (&ldquo;{org.defaultTeamLabels?.[0] ?? "Red"}&rdquo; /
            &ldquo;{org.defaultTeamLabels?.[1] ?? "Yellow"}&rdquo;).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                First team
              </label>
              <input
                value={teamRed}
                onChange={(e) => setTeamRed(e.target.value)}
                placeholder={org.defaultTeamLabels?.[0] ?? "Red"}
                maxLength={24}
                className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                Second team
              </label>
              <input
                value={teamYellow}
                onChange={(e) => setTeamYellow(e.target.value)}
                placeholder={org.defaultTeamLabels?.[1] ?? "Yellow"}
                maxLength={24}
                className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <button
            onClick={saveTeamLabels}
            disabled={savingTeamLabels}
            className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
          >
            {savingTeamLabels ? "Saving…" : "Save team names"}
          </button>
        </div>
      </section>

      {/* Bot language */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <Languages className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Bot language</h2>
          <SectionInfo k="st_language" lang={org.language} />
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-500">
            The language MatchTime speaks in this group. Turkish copy is
            being added in stages; until a message has been translated it
            is sent in English.
          </p>
          <select
            value={normaliseLang(org.language)}
            onChange={(e) => saveLanguage(e.target.value as Lang)}
            disabled={savingLanguage}
            className="h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {LANGS.map((code) => (
              <option key={code} value={code}>
                {LANG_LABELS[code]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Invite */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <LinkIcon className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Invite link</h2>
          <SectionInfo k="st_invite" lang={org.language} />
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-500">
            Share this link with players to join your organisation.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={inviteLink}
              readOnly
              className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
            />
            <button
              onClick={copyInviteLink}
              className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
            >
              <Copy className="w-4 h-4" />
              Copy
            </button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Bot features</h2>
          <SectionInfo k="st_features" lang={org.language} />
        </div>
        <div className="p-6">
          <p className="text-sm text-slate-500 mb-4">
            Turn individual capabilities on or off. A group can run just the
            bits it wants — e.g. only Man of the Match and player ratings.
            Changes take effect on the bot&apos;s next cycle.
          </p>
          <div className="divide-y divide-slate-100">
            {FEATURE_META.map((m) => {
              const key = m.key as FeatureKey;
              const on = org.features?.[key] ?? false;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      <span>{m.label}</span>
                      <SectionInfo k={FEATURE_INFO[key]} lang={org.language} />
                    </div>
                    <p className="text-xs text-slate-500">{m.blurb}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={on}
                    disabled={savingFeature === key}
                    onClick={() => toggleFeature(key, !on)}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                      on ? "bg-green-500" : "bg-slate-300"
                    }`}
                    title={on ? "Click to disable" : "Click to enable"}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        on ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              );
            })}
            {/* Badge announcements (2026-10-01). Its own row, not in
                FEATURE_META (that list is also the numbered in-group
                setup menu). Words from the club's language table. */}
            {(() => {
              const s = t(org.language);
              const key: FeatureKey = "badgeAnnouncements";
              const on = org.features?.[key] ?? true;
              return (
                <div className="flex items-center justify-between gap-4 py-3" data-testid="feature-badge-announcements">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {s.badges_feature_label}
                      <SectionInfo k={FEATURE_INFO.badgeAnnouncements} lang={org.language} />
                    </div>
                    <p className="text-xs text-slate-500">{s.badges_feature_blurb}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={on}
                    aria-label={s.badges_feature_label}
                    disabled={savingFeature === key}
                    onClick={() => toggleFeature(key, !on)}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                      on ? "bg-green-500" : "bg-slate-300"
                    }`}
                    title={on ? "Click to disable" : "Click to enable"}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        on ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      </section>

      {/* Weekly routine (2026-09-30). Words from the club's language
          table. Slices 2 and 3 add their rows to this section. */}
      {(() => {
        const s = t(org.language);
        const on = org.weeklyRoutine?.rollingSquad ?? false;
        return (
          <section className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="weekly-routine">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
              <Repeat className="w-4 h-4 text-slate-500" />
              <h2 className="font-semibold text-slate-800">{s.wr_section_title}</h2>
              <SectionInfo k="st_weekly" lang={org.language} />
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-500 mb-4">{s.wr_section_lead}</p>
              <div className="divide-y divide-slate-100">
                <div className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {s.wr_rolling_label}
                      <InfoButton title={s.wr_rolling_label}>
                        <p>{s.wr_rolling_info}</p>
                      </InfoButton>
                    </div>
                    <p className="text-xs text-slate-500">{s.wr_rolling_blurb}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={on}
                    aria-label={s.wr_rolling_label}
                    disabled={savingRoutine === "rollingSquad"}
                    onClick={() => toggleRollingSquad(!on)}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                      on ? "bg-green-500" : "bg-slate-300"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        on ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                {/* Organiser pick (slice 2b): who fills an open place. */}
                <PickModeRows
                  orgId={org.id}
                  language={org.language}
                  benchPickMode={org.weeklyRoutine?.benchPickMode ?? "first-come"}
                  benchPickFallback={org.weeklyRoutine?.benchPickFallback ?? "bench-offer"}
                />
                {/* Weekly deadlines (slice 3): its own component. */}
                <WeeklyDeadlineRows
                  orgId={org.id}
                  language={org.language}
                  dropOutDeadline={org.weeklyRoutine?.dropOutDeadline ?? null}
                  listPublish={org.weeklyRoutine?.listPublish ?? null}
                />
                {/* Slice 2a: where admin messages go. */}
                <AdminChannelSettings orgId={org.id} lang={normaliseLang(org.language)} />
              </div>
            </div>
          </section>
        );
      })()}

      {/* Club fee billing (slice B2). "Choose a money collector" points at
          the collector picker below, which only exists while payment
          collection is on. */}
      {org.billing && (
        <BillingSettingsCard data={org.billing} lang={org.language} collectorAnchor={org.features?.paymentCollection ? "#payments" : null} />
      )}

      {/* Payments — Connect bank */}
      {org.features?.paymentCollection && (
        <section id="payments" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
            <Landmark className="w-4 h-4 text-slate-500" />
            <h2 className="font-semibold text-slate-800">Money collector&apos;s bank</h2>
          <SectionInfo k="st_bank" lang={org.language} />
          </div>
          <div className="p-6 space-y-4">
            {/* Who collects the money */}
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <label className="block text-sm font-medium text-slate-700">Money collector</label>
                <SectionInfo k="st_collector" lang={org.language} />
              </div>
              <select
                value={org.paymentHolderId ?? ""}
                onChange={(e) => changeHolder(e.target.value)}
                disabled={savingHolder}
                className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 disabled:opacity-50"
              >
                <option value="" disabled>
                  Choose a member…
                </option>
                {(org.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? "Unnamed"}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-400 mt-1.5">
                Gets the &ldquo;how much per player?&rdquo; prompt after each match, receives
                &ldquo;pay you directly&rdquo; confirmations, and is whose connected bank the
                card payouts settle to. Only members with a phone number are listed.
              </p>
            </div>

            <hr className="border-slate-100" />

            <p className="text-sm text-slate-500">
              Card payments go straight to the money collector&apos;s bank
              (via Stripe). Connect it once — Stripe handles the rest. (&ldquo;Pay
              directly&rdquo; needs no bank.)
            </p>
            {!org.stripeChargesEnabled && (
              <p className="text-xs text-slate-400">
                Stripe will ask you to confirm a few identity details and add your bank
                account — choose <span className="font-medium text-slate-500">Individual</span>{" "}
                when asked; the business details are already filled in for you. Takes ~2 minutes.
              </p>
            )}
            {org.stripeChargesEnabled ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-sm font-medium">
                  <CheckCircle2 className="w-4 h-4" /> Bank connected — ready to take payments
                </div>
                <button
                  onClick={manageBank}
                  className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
                >
                  <Landmark className="w-4 h-4" /> Manage bank / payouts
                </button>
                <button
                  onClick={resetBank}
                  disabled={resetting}
                  className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-600 hover:text-red-600 font-medium disabled:opacity-50"
                >
                  {resetting ? "Disconnecting…" : "Disconnect / start over"}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={connectBank}
                  disabled={connecting}
                  className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
                >
                  <Landmark className="w-4 h-4" />
                  {connecting ? "Opening Stripe…" : org.stripeConnected ? "Finish bank setup" : "Connect bank"}
                </button>
                {org.stripeConnected && (
                  <>
                    <button
                      onClick={refreshBank}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
                    >
                      Refresh status
                    </button>
                    <button
                      onClick={resetBank}
                      disabled={resetting}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-600 hover:text-red-600 font-medium disabled:opacity-50"
                    >
                      {resetting ? "Resetting…" : "Start over"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* WhatsApp */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">WhatsApp bot</h2>
          <SectionInfo k="st_whatsapp" lang={org.language} />
        </div>
        <div className="p-6 space-y-4">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              org.whatsappBotEnabled
                ? "bg-green-100 text-green-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {org.whatsappBotEnabled ? "Enabled" : "Disabled"}
          </span>
          {org.whatsappGroupId && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                WhatsApp group ID
              </label>
              <input
                value={org.whatsappGroupId}
                disabled
                className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
              />
            </div>
          )}
          <p className="text-xs text-slate-500">
            Bot configuration is managed server-side. Contact your administrator to enable or reconfigure.
          </p>
        </div>
      </section>
    </div>
  );
}
