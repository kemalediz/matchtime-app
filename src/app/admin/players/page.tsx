"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Phone,
  Star,
  Shield,
  Check,
  X,
  Sparkles,
  GitMerge,
  Tag,
  Plus,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import {
  updatePlayerRole,
  makeOwner,
  seedPlayerRating,
  confirmProvisionalPlayer,
  removeProvisionalPlayer,
  updatePlayerName,
  updatePlayerPhone,
  linkPlayerByPhone,
  type PhoneLinkOffer,
  mergePlayers,
  addPlayerAlias,
  removePlayerAlias,
  createPlayer,
} from "@/app/actions/players";
import { groupSyncAdminWarning } from "@/lib/group-membership-gate";
import { t } from "@/lib/i18n/t";
import { adminPlayerInitial, adminPlayerLabel } from "@/lib/admin-player-label";
import { DEFAULT_LANG, type Lang } from "@/lib/i18n/lang";
import { PhoneLinkDialog } from "./phone-link-dialog";
import { ProvisionalPlayersBanner, ClubRatingCell, DuplicateSuggestionsBanner, PlayersInfoLegend } from "./player-row-bits";
import { SectionInfo } from "@/components/info/section-info";
import type { DuplicateSuggestion } from "@/lib/placeholder-link-rules";

interface Player {
  id: string;
  name: string | null;
  /** Null for a partner club's guest: his email is never sent. */
  email: string | null;
  image: string | null;
  role: string;
  positions: string[];
  seedRating: number | null;
  /** This club's rating of them, the number they see on their own page.
   *  Null only when the caller is not an owner or admin. */
  clubRating: { rating: number | null; ratedGames: number } | null;
  phoneNumber: string | null;
  isActive: boolean;
  leftAt: string | null;
  provisionallyAddedAt: string | null;
  /** A guest from a partner club (cross-club ask, S4): that club's name.
   *  His phone and email are never sent. */
  guestFrom?: string | null;
  aliases: Array<{ alias: string; source: string }>;
  _count: { attendances: number };
}

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);
  // The banner and the club-rating column follow the club's language,
  // like the seed editor's hint on /admin/players/ratings.
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const [includeFormer, setIncludeFormer] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [adding, setAdding] = useState(false);
  // Age of the bot's last successful participant sweep. When it goes
  // quiet the app's self-IN gate starts turning real players away, so the
  // roster page says so rather than leaving it to the server log.
  const [lastGroupSyncAt, setLastGroupSyncAt] = useState<string | null | undefined>(undefined);
  // Placeholders that may be a phone member under another row (2026-09-29).
  const [duplicates, setDuplicates] = useState<DuplicateSuggestion[]>([]);
  const [viewerIsOwner, setViewerIsOwner] = useState(false);

  useEffect(() => {
    fetch("/api/org/settings").then((r) => r.json()).then((d) => {
      setOrgId(d.id);
      if (d.language) setLang(d.language as Lang);
    });
  }, []);

  useEffect(() => {
    loadPlayers(includeFormer);
  }, [includeFormer]);

  async function loadPlayers(withFormer: boolean) {
    setLoading(true);
    const qs = withFormer ? "?includeFormer=1" : "";
    const res = await fetch(`/api/players${qs}`);
    if (res.ok) {
      const data = await res.json();
      setPlayers(Array.isArray(data) ? data : data.players ?? []);
      setLastGroupSyncAt(Array.isArray(data) ? undefined : (data.groupSync?.lastSyncAt ?? null));
      setDuplicates(Array.isArray(data) ? [] : (data.duplicateSuggestions ?? []));
      setViewerIsOwner(!Array.isArray(data) && data.viewerIsOwner === true);
    }
    setLoading(false);
  }

  async function handleRoleChange(userId: string, role: string) {
    if (!orgId) return;
    try {
      const res = await updatePlayerRole(userId, orgId, role as "ADMIN" | "PLAYER");
      if (!res.ok) {
        toast.error(
          res.reason === "owner-locked" ? t(lang).admin_players_role_owner_locked : t(lang).admin_players_role_refused,
        );
      } else if (res.changed) {
        toast.success(t(lang).admin_players_role_updated);
      }
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleMakeOwner(userId: string, name: string) {
    if (!orgId) return;
    if (!confirm(t(lang).admin_players_make_owner_confirm({ name }))) return;
    try {
      const res = await makeOwner(userId, orgId);
      if (res.ok) toast.success(t(lang).admin_players_make_owner_done({ name }));
      else if (res.reason === "not-owner") toast.error(t(lang).admin_players_make_owner_refused);
      else toast.error(t(lang).admin_players_role_refused);
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleSeedRating(userId: string, value: string) {
    // Integers only — the whole numbers are easier to reason about and
    // the balancer picks up 1-point differences fine.
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1 || num > 10 || !orgId) return;
    try {
      await seedPlayerRating(userId, orgId, num);
      // Optimistic in-place update — keeps scroll position and focus so
      // admin can rate many players in a row without fighting the page.
      setPlayers((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, seedRating: num } : p)),
      );
      toast.success("Rating updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRename(userId: string, name: string, original: string | null) {
    if (!orgId) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === (original ?? "")) return; // no-op
    try {
      const res = await updatePlayerName(userId, orgId, trimmed);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPlayers((prev) => prev.map((p) => (p.id === userId ? { ...p, name: trimmed } : p)));
      toast.success("Name updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // "Same person?" (FNF 2026-10-18): the number belongs to somebody at
  // another club. Held here until the admin answers.
  const [linkAsk, setLinkAsk] = useState<
    { userId: string; offer: PhoneLinkOffer; input: HTMLInputElement | null; original: string | null } | null
  >(null);
  const [linking, setLinking] = useState(false);

  function resetPhoneInput(input: HTMLInputElement | null, original: string | null) {
    if (input) input.value = original ?? "";
  }

  async function handleLinkYes() {
    if (!orgId || !linkAsk) return;
    setLinking(true);
    try {
      const res = await linkPlayerByPhone(linkAsk.userId, orgId, linkAsk.offer.phone);
      if (!res.ok) {
        resetPhoneInput(linkAsk.input, linkAsk.original);
        toast.error(res.error);
      } else {
        toast.success(t(lang).phone_link_done);
        await loadPlayers(includeFormer);
      }
    } catch {
      resetPhoneInput(linkAsk.input, linkAsk.original);
      toast.error(t(lang).phone_err_generic);
    } finally {
      setLinking(false);
      setLinkAsk(null);
    }
  }

  function handleLinkNo() {
    if (!linkAsk) return;
    resetPhoneInput(linkAsk.input, linkAsk.original);
    toast.error(t(lang).phone_link_declined);
    setLinkAsk(null);
  }

  async function handlePhone(
    userId: string,
    phone: string,
    original: string | null,
    input: HTMLInputElement | null = null,
  ) {
    if (!orgId) return;
    const trimmed = phone.trim();
    if (trimmed === (original ?? "")) return; // no-op
    try {
      const res = await updatePlayerPhone(userId, orgId, trimmed);
      if (!res.ok) {
        if (res.link) {
          setLinkAsk({ userId, offer: res.link, input, original });
          return;
        }
        resetPhoneInput(input, original);
        toast.error(res.error);
        return;
      }
      // If the action auto-merged an orphan (wa-sync OR provisional),
      // the player list shape has changed under us — one row removed,
      // another updated. Just reload rather than trying to patch.
      const merged = res.mergedSyncOrphan || res.mergedProvisional;
      if (merged) {
        await loadPlayers(includeFormer);
        if (res.redirectToUserId) {
          toast.success("Merged into the existing player record with that phone");
        } else {
          toast.success("Phone updated. Merged a duplicate placeholder.");
        }
        return;
      }
      setPlayers((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, phoneNumber: res.phoneNumber } : p)),
      );
      toast.success("Phone updated");
    } catch {
      // A network failure, say. Never the redacted server error.
      resetPhoneInput(input, original);
      toast.error(t(lang).phone_err_generic);
    }
  }

  const [mergeFrom, setMergeFrom] = useState<string | null>(null); // user id we're merging FROM

  async function handleMerge(dropId: string, keepId: string) {
    if (!orgId) return;
    if (!confirm(`Merge into the chosen player? The duplicate row will be deleted, all attendance/ratings/messages re-attributed to the kept player. This cannot be undone.`)) return;
    try {
      const res = await mergePlayers(orgId, keepId, dropId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Players merged");
      setMergeFrom(null);
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Track which row's "add alias" input is open (one at a time).
  const [aliasInputFor, setAliasInputFor] = useState<string | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState("");

  async function handleAddAlias(userId: string) {
    if (!orgId) return;
    const value = aliasInputValue.trim();
    if (!value) { setAliasInputFor(null); return; }
    try {
      const res = await addPlayerAlias(userId, orgId, value);
      if (!res.ok) {
        // Expected validation failure (e.g. alias already on another
        // player) — returned as data, not thrown, so the message survives
        // Next's production error redaction.
        toast.error(res.error);
        return;
      }
      // Optimistic update — push the new alias into the row.
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === userId
            ? {
                ...p,
                aliases: res.alreadyExisted
                  ? p.aliases
                  : [...p.aliases, { alias: res.alias, source: "manual" }],
              }
            : p,
        ),
      );
      toast.success(res.alreadyExisted ? `"${res.alias}" already linked` : `Added alias "${res.alias}"`);
      setAliasInputFor(null);
      setAliasInputValue("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleAddPlayer() {
    if (!orgId) return;
    if (!addName.trim() && !addPhone.trim()) {
      toast.error("Enter a name (and optionally a phone)");
      return;
    }
    setAdding(true);
    try {
      const res = await createPlayer(orgId, addName, addPhone || undefined);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.rejoined
          ? "Welcomed back an existing player"
          : res.created
            ? `Added ${addName.trim() || "player"}`
            : "Added existing player to this group",
      );
      setAddName("");
      setAddPhone("");
      setShowAdd(false);
      await loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add player");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveAlias(userId: string, alias: string) {
    if (!orgId) return;
    if (!confirm(`Remove alias "${alias}"? Next time the bot sees that pushname, it'll fall back to fuzzy matching.`)) return;
    try {
      await removePlayerAlias(userId, orgId, alias);
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === userId ? { ...p, aliases: p.aliases.filter((a) => a.alias !== alias) } : p,
        ),
      );
      toast.success(`Removed alias "${alias}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleConfirm(userId: string) {
    if (!orgId) return;
    try {
      await confirmProvisionalPlayer(userId, orgId);
      toast.success("Player confirmed");
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRemove(userId: string) {
    if (!orgId) return;
    if (!confirm("Remove this player? Their attendance and rating history is kept, but they won't appear in future matches, and MatchTime won't bring them back as a guest through the player pool or a friend's link. Adding them back yourself undoes this.")) return;
    try {
      const res = await removeProvisionalPlayer(userId, orgId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Player removed");
      loadPlayers(includeFormer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  const withPhoneCount = players.filter((p) => p.phoneNumber).length;
  const leftCount = players.filter((p) => p.leftAt).length;
  const provisionalPlayers = players.filter((p) => p.provisionallyAddedAt && !p.leftAt);
  const groupSyncWarning =
    lastGroupSyncAt === undefined
      ? null
      : groupSyncAdminWarning({
          lastSyncAt: lastGroupSyncAt ? new Date(lastGroupSyncAt) : null,
          now: new Date(),
        });

  return (
    <div className="space-y-6">
      <PhoneLinkDialog
        offer={linkAsk?.offer ?? null}
        lang={lang}
        busy={linking}
        onYes={handleLinkYes}
        onNo={handleLinkNo}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="flex items-center gap-1 text-lg font-semibold text-slate-800">
            Players ({players.length})
            <SectionInfo k="pl_list" lang={lang} />
          </h2>
          <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeFormer}
              onChange={(e) => setIncludeFormer(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              Include former members
              {includeFormer && leftCount > 0 ? (
                <span className="ml-1 text-slate-400">({leftCount} left)</span>
              ) : null}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowAdd((s) => !s)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add player
          </button>
          <Link
            href="/admin/players/phones"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Phone className="w-4 h-4" />
            Phones
            <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold">
              {withPhoneCount}/{players.length}
            </span>
          </Link>
          <Link
            href="/admin/players/positions"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Shield className="w-4 h-4" />
            Positions
          </Link>
          <Link
            href="/admin/players/ratings"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
          >
            <Star className="w-4 h-4" />
            Seed ratings
          </Link>
        </div>
      </div>

      {groupSyncWarning && (
        <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
          <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600" />
          <div>
            {/* Was "WhatsApp group sync is behind", which reads as a
                queue that will catch up on its own. It will not: the
                sweep has not run since 2026-07-07 and cannot until the
                WhatsApp-side breakage is worked around. Say what is
                actually true, and what it costs. */}
            <p className="text-sm font-semibold text-amber-900">
              MatchTime can&apos;t read your WhatsApp group&apos;s member list
            </p>
            <p className="mt-1 text-sm text-amber-800">{groupSyncWarning}</p>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
          <p className="flex items-center gap-1 text-sm font-medium text-slate-800 mb-3">
            Add a player
            <SectionInfo k="pl_add" lang={lang} />
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Name (e.g. Mo)"
              className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-800"
              onKeyDown={(e) => e.key === "Enter" && handleAddPlayer()}
            />
            <input
              value={addPhone}
              onChange={(e) => setAddPhone(e.target.value)}
              placeholder="Phone (optional, e.g. 07952130028)"
              className="flex-1 h-11 px-3 rounded-lg border border-slate-200 bg-white font-mono text-sm text-slate-800"
              onKeyDown={(e) => e.key === "Enter" && handleAddPlayer()}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddPlayer}
                disabled={adding}
                className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add"}
              </button>
              <button
                onClick={() => { setShowAdd(false); setAddName(""); setAddPhone(""); }}
                className="px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Adding a phone is recommended: it links them across groups and lets
            the bot recognise them automatically. If that number already exists
            anywhere, we&apos;ll reuse it instead of creating a duplicate.
          </p>
        </div>
      )}

      <p className="text-sm text-slate-500">
        {/* {" "} on purpose: a text run that ends in a line break loses its
            leading space in this build ("Seed ratingis", 2026-09-29). */}
        <span className="font-medium text-slate-700">Seed rating</span>{" "}is the player&apos;s
        starting skill score (1 to 10) used by the team-balancer until they&apos;ve
        accumulated enough peer ratings from completed matches.
      </p>

      <PlayersInfoLegend lang={lang} />

      <ProvisionalPlayersBanner
        names={provisionalPlayers.map((p) => p.name).filter((n): n is string => Boolean(n))}
        count={provisionalPlayers.length}
        lang={lang}
      />

      <DuplicateSuggestionsBanner suggestions={duplicates} lang={lang} onMerge={handleMerge} />

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-6 py-3 border-b border-slate-100 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Player</span>
          <span className="w-24 text-center">Seed rating</span>
          <span className="w-24 text-center">{t(lang).admin_players_club_rating_header}</span>
          <span className="w-28 text-center">Role</span>
        </div>
        <div className="divide-y divide-slate-100">
          {players.map((p) => (
            <div
              key={p.id}
              data-testid={`player-row-${p.id}`}
              className={`flex flex-col gap-3 sm:grid sm:grid-cols-[1fr_auto_auto_auto] sm:gap-4 px-4 sm:px-6 py-4 sm:items-center ${
                p.leftAt ? "bg-slate-50/70 opacity-70" : p.provisionallyAddedAt ? "bg-amber-50/50" : ""
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div data-testid="player-initial" className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                  p.provisionallyAddedAt ? "bg-amber-100 text-amber-700" : "bg-blue-50 text-blue-700"
                }`}>
                  {/* A partner guest's email is null and his name can be too
                      (prod, MT Test, 2026-10-23): this used to throw. */}
                  {adminPlayerInitial(p)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <input
                      type="text"
                      defaultValue={p.name ?? ""}
                      placeholder={adminPlayerLabel(p, lang)}
                      onBlur={(e) => handleRename(p.id, e.target.value, p.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          (e.target as HTMLInputElement).value = p.name ?? "";
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="font-semibold text-slate-800 bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none min-w-[6rem] flex-1 px-0 py-0.5 rounded-none"
                      title="Click to rename"
                    />
                    {p.leftAt && (
                      <span className="inline-flex shrink-0 px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-semibold uppercase tracking-wider">
                        Left
                      </span>
                    )}
                    {p.guestFrom && (
                      <span data-testid="guest-badge" className="inline-flex shrink-0 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[10px] font-semibold">
                        {t(lang).xask_guest_badge({ club: p.guestFrom })}
                      </span>
                    )}
                    {p.provisionallyAddedAt && !p.leftAt && (
                      <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wider">
                        <Sparkles className="w-3 h-3" /> New
                      </span>
                    )}
                    {!p.leftAt && !p.guestFrom && (
                      <button
                        onClick={() => setMergeFrom(mergeFrom === p.id ? null : p.id)}
                        className={`inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold ${
                          mergeFrom === p.id
                            ? "bg-blue-600 text-white"
                            : "bg-slate-100 hover:bg-slate-200 text-slate-600"
                        }`}
                        title="Duplicate of another player? Merge them."
                      >
                        <GitMerge className="w-3 h-3" /> Merge
                      </button>
                    )}
                  </div>
                  {/* Provisional players: Confirm / Remove live on their own
                      wrapping row so they can never crowd the name input to
                      zero width on narrow screens (2026-06-11). */}
                  {p.provisionallyAddedAt && !p.leftAt && (
                    <div className="flex items-center gap-2 flex-wrap mt-1.5">
                      <button
                        onClick={() => handleConfirm(p.id)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 hover:bg-green-700 text-white text-[10px] font-semibold"
                        title="Confirm this is a real player"
                      >
                        <Check className="w-3 h-3" /> Confirm
                      </button>
                      <button
                        onClick={() => handleRemove(p.id)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-semibold"
                        title="Not a player? Remove"
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  )}
                  {mergeFrom === p.id && (
                    <div className="mt-2 p-2 rounded bg-slate-50 border border-slate-200 text-xs">
                      <p className="text-slate-700 mb-1.5">
                        Merge{" "}<strong>{adminPlayerLabel(p, lang)}</strong>{" "}into another player. Pick the one to keep:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {players
                          .filter((q) => q.id !== p.id && !q.leftAt)
                          .map((q) => (
                            <button
                              key={q.id}
                              onClick={() => handleMerge(p.id, q.id)}
                              className="px-2 py-1 rounded bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-slate-700"
                            >
                              {adminPlayerLabel(q, lang)}
                            </button>
                          ))}
                        <button
                          onClick={() => setMergeFrom(null)}
                          className="px-2 py-1 rounded text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {(p.aliases.length > 0 || aliasInputFor === p.id) && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <Tag className="w-3 h-3 text-slate-400 shrink-0" />
                      {p.aliases.map((a) => (
                        <button
                          key={a.alias}
                          onClick={() => handleRemoveAlias(p.id, a.alias)}
                          className="group inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 text-[11px] font-medium transition-colors"
                          title={`Alias "${a.alias}". Click to remove (source: ${a.source})`}
                        >
                          {a.alias}
                          <X className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100" />
                        </button>
                      ))}
                      {aliasInputFor === p.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={aliasInputValue}
                          onChange={(e) => setAliasInputValue(e.target.value)}
                          onBlur={() => handleAddAlias(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") {
                              setAliasInputFor(null);
                              setAliasInputValue("");
                            }
                          }}
                          placeholder="nickname…"
                          className="w-28 px-1.5 py-0.5 text-[11px] rounded border border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      ) : (
                        <button
                          onClick={() => { setAliasInputFor(p.id); setAliasInputValue(""); }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50 text-slate-400 hover:text-blue-600 text-[11px] font-medium transition-colors"
                          title="Add a nickname / alternate name the bot should recognise"
                        >
                          <Plus className="w-2.5 h-2.5" /> add
                        </button>
                      )}
                    </div>
                  )}
                  {p.aliases.length === 0 && aliasInputFor !== p.id && (
                    <button
                      onClick={() => { setAliasInputFor(p.id); setAliasInputValue(""); }}
                      className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-blue-600 transition-colors"
                      title="Add a nickname / alternate name the bot should recognise"
                    >
                      <Tag className="w-2.5 h-2.5" /> add alias
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5 flex-wrap">
                    {p.positions.map((pos) => (
                      <span
                        key={pos}
                        className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold"
                      >
                        {pos}
                      </span>
                    ))}
                    <span>{p.positions.length > 0 ? "·" : ""} {p._count.attendances} matches</span>
                    {!p.guestFrom && <span className="text-slate-300">·</span>}
                    {!p.guestFrom && (
                    <input
                      type="tel"
                      defaultValue={p.phoneNumber ?? ""}
                      placeholder="+44 7…"
                      onBlur={(e) => handlePhone(p.id, e.target.value, p.phoneNumber, e.target)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          (e.target as HTMLInputElement).value = p.phoneNumber ?? "";
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="text-xs text-slate-500 bg-transparent border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none w-32 px-0 py-0.5 rounded-none"
                      title="Phone number, used for personal DMs (rating links, reminders)"
                    />
                    )}
                  </div>
                </div>
              </div>
              {/* Mobile: seed, club rating and role sit in one row below the
                  player block. sm:contents dissolves this wrapper at >=sm so
                  the three boxes become direct grid children again
                  (preserving the desktop 4-column layout). */}
              <div className="flex gap-4 sm:contents">
                <div className="w-24 flex flex-col items-center">
                  <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                    Seed
                  </label>
                  <input
                    type="number"
                    defaultValue={p.seedRating != null ? Math.round(p.seedRating) : ""}
                    min={1}
                    max={10}
                    step={1}
                    title="Seed rating (1 to 10) for this club. Used by the team-balancer until peer ratings accumulate. A player at another club keeps a separate rating there."
                    onBlur={(e) => e.target.value && handleSeedRating(p.id, e.target.value)}
                    className="w-20 h-10 px-2 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                {/* Always rendered so the desktop grid keeps its four
                    columns; empty only if the API withheld the rating. */}
                <div className="w-24 flex flex-col items-center" data-testid="club-rating">
                  {p.clubRating && (
                    <>
                      <span className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                        {t(lang).admin_players_club_rating_header}
                      </span>
                      <ClubRatingCell rating={p.clubRating.rating} ratedGames={p.clubRating.ratedGames} lang={lang} />
                    </>
                  )}
                </div>
                <div className="w-28 flex flex-col items-center">
                  <label className="sm:hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-0.5">
                    Role
                  </label>
                  {/* The owner's role is read-only for everybody, the owner
                      included: it changes only through "Make owner", which
                      only the owner sees. The old picker had no Owner option,
                      so it showed the owner as "Player" and any pick wrote
                      ADMIN or PLAYER over OWNER (2026-10-20, FNF). */}
                  {p.role === "OWNER" ? (
                    <select
                      value="OWNER"
                      disabled
                      data-testid="role-owner"
                      aria-label={t(lang).admin_players_role_owner}
                      className="w-28 h-10 px-2 rounded-lg border border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700"
                    >
                      <option value="OWNER">{t(lang).admin_players_role_owner}</option>
                    </select>
                  ) : (
                    <select
                      value={p.role}
                      onChange={(e) => handleRoleChange(p.id, e.target.value)}
                      className="w-28 h-10 px-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="PLAYER">Player</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  )}
                  {viewerIsOwner && p.role !== "OWNER" && !p.leftAt && !p.guestFrom && (
                    <button
                      type="button"
                      onClick={() => handleMakeOwner(p.id, p.name ?? "")}
                      className="mt-1 text-xs text-blue-600 hover:underline"
                    >
                      {t(lang).admin_players_make_owner}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
