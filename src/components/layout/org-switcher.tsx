"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, Check, ChevronDown, Plus } from "lucide-react";
import { switchOrg } from "@/app/actions/org";

interface OrgMembership {
  id: string;
  role: "OWNER" | "ADMIN" | "PLAYER";
  org: { id: string; name: string; slug: string };
}

/**
 * Compact org selector that sits inside the Sidebar's brand block.
 * Click opens a dropdown with all the user's memberships (filters out
 * memberships marked as `leftAt`) and a "Create new organisation" link.
 *
 * Switching calls the `switchOrg` server action which updates the
 * `orgId` cookie the rest of the app reads via `getUserOrg()`. After
 * switch we `router.refresh()` so every RSC re-runs with the new scope.
 */
export function OrgSwitcher() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<OrgMembership[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [current, setCurrent] = useState<OrgMembership | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/memberships")
      .then((r) => (r.ok ? r.json() : { memberships: [], currentOrgId: null }))
      .then((data) => {
        setMemberships(data.memberships ?? []);
        const cur = (data.memberships ?? []).find(
          (m: OrgMembership) => m.org.id === data.currentOrgId,
        );
        setCurrent(cur ?? data.memberships?.[0] ?? null);
      });
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function handleSwitch(orgId: string) {
    if (orgId === current?.org.id) {
      setOpen(false);
      return;
    }
    setSwitching(orgId);
    try {
      await switchOrg(orgId);
      // router.refresh() re-runs RSCs with the new cookie, but THIS
      // client component's state persists across the refresh — the
      // mount-time useEffect that originally populated `current`
      // doesn't fire again. Without this line the brand block keeps
      // showing the previous org's name even though the rest of the
      // page already reflects the switch (Kemal 2026-05-28).
      const next = memberships?.find((m) => m.org.id === orgId);
      if (next) setCurrent(next);
      router.refresh();
      setOpen(false);
    } finally {
      setSwitching(null);
    }
  }

  if (!memberships || memberships.length === 0 || !current) {
    // Don't render anything if the user doesn't have an org yet — /create-org
    // redirect handles that case.
    return null;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-slate-800 transition-colors"
      >
        <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-white truncate">
            {current.org.name}
          </span>
          {memberships.length > 1 && (
            <span className="block text-[10px] text-slate-400 uppercase tracking-wider">
              {memberships.length} orgs · tap to switch
            </span>
          )}
        </span>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 rounded-lg bg-slate-800 border border-slate-700 shadow-xl z-20 overflow-hidden">
          <div className="max-h-64 overflow-y-auto">
            {memberships.map((m) => {
              const active = m.org.id === current.org.id;
              return (
                <button
                  key={m.id}
                  onClick={() => handleSwitch(m.org.id)}
                  disabled={switching !== null}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-700 disabled:opacity-50 ${
                    active ? "bg-slate-700/50" : ""
                  }`}
                >
                  <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-white truncate">{m.org.name}</span>
                    <span className="block text-[10px] text-slate-400 uppercase tracking-wider">
                      {m.role.toLowerCase()}
                    </span>
                  </span>
                  {active && <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />}
                </button>
              );
            })}
          </div>
          <Link
            href="/onboarding"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2.5 border-t border-slate-700 text-sm text-blue-400 hover:text-blue-300 hover:bg-slate-700"
          >
            <Plus className="w-4 h-4 shrink-0" />
            Create new organisation
          </Link>
        </div>
      )}
    </div>
  );
}
