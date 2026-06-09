"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Link as LinkIcon, Users, Settings, MessageCircle, SlidersHorizontal, Landmark, CheckCircle2 } from "lucide-react";
import { setOrgFeature } from "@/app/actions/org";
import { startCollectorOnboarding, refreshCollectorStatus, resetCollectorConnect, openCollectorDashboard } from "@/app/actions/payments";
import { FEATURE_META, type ToggleableKey } from "@/lib/org-features-meta";

type FeatureKey = ToggleableKey;

interface OrgData {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  memberCount: number;
  features: Record<FeatureKey, boolean>;
  stripeConnected?: boolean;
  stripeChargesEnabled?: boolean;
}

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then(setOrg)
      .finally(() => setLoading(false));
  }, []);

  async function copyInviteLink() {
    if (!org) return;
    const link = `${window.location.origin}/join/${org.inviteCode}`;
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied!");
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

      {/* Invite */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <LinkIcon className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Invite link</h2>
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
                    <p className="text-sm font-medium text-slate-800">
                      {m.label}
                    </p>
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
          </div>
        </div>
      </section>

      {/* Payments — Connect bank */}
      {org.features?.paymentCollection && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
            <Landmark className="w-4 h-4 text-slate-500" />
            <h2 className="font-semibold text-slate-800">Money collector&apos;s bank</h2>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-slate-500">
              Card &amp; Pay-by-Bank payments go straight to the money collector&apos;s bank
              (via Stripe). Connect it once — Stripe handles the rest. (&ldquo;Pay
              directly&rdquo; needs no bank.)
            </p>
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
