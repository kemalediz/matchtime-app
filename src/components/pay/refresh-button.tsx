"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/** Soft-refresh the collect page (re-runs the server component → fresh
 *  payment state) without a full reload. The page is force-dynamic, so
 *  router.refresh() re-reads the DB. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [spin, setSpin] = useState(false);

  function refresh() {
    setSpin(true);
    startTransition(() => router.refresh());
    // Let the spin run briefly even if the refresh is instant.
    setTimeout(() => setSpin(false), 600);
  }

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={pending}
      className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-sm font-medium disabled:opacity-60"
    >
      <RefreshCw className={`w-4 h-4 ${spin || pending ? "animate-spin" : ""}`} />
      Refresh
    </button>
  );
}
