"use client";

/**
 * "Add MatchTime to WhatsApp". Issues (or reuses) the club's connect
 * code on the server and opens WhatsApp with the prefilled message. The
 * page refreshes behind it, so on return the card shows the code and an
 * "Open WhatsApp again" link.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startClubConnect } from "@/app/actions/club-connect";

export function ConnectButton({ orgId, label, fallbackError }: { orgId: string; label: string; fallbackError: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const leaving = useRef(false);

  // WhatsApp can open without this page going away (the app takes the
  // link), and Back can restore the page as it was left. Coming back to
  // it hands the button back.
  useEffect(() => {
    function onReturn() {
      if (!leaving.current || document.visibilityState !== "visible") return;
      leaving.current = false;
      submitting.current = false;
      setLoading(false);
    }
    window.addEventListener("pageshow", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("pageshow", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  async function onClick() {
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    setLoading(true);
    // Stays busy on success: WhatsApp is opening, and the refresh swaps
    // this button for the code and the "Open WhatsApp again" link.
    try {
      const res = await startClubConnect(orgId);
      router.refresh();
      if (res.ok) {
        leaving.current = true;
        window.location.assign(res.href);
      } else setError(res.error);
    } catch {
      setError(fallbackError);
    } finally {
      if (!leaving.current) {
        submitting.current = false;
        setLoading(false);
      }
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        data-testid="club-connect-button"
        className="inline-flex items-center justify-center h-11 px-4 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-60"
      >
        {label}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
