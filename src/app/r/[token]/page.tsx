"use client";

/**
 * Magic-link landing page.
 *
 * URL shape: /r/[token]
 *
 * Flow:
 *   1. On mount, call signIn("magic-link", { token, redirect: false }).
 *   2. On success, verify the token client-side (just to read the intended
 *      destination from its payload) and redirect there.
 *   3. On failure, show a clear error + a "Go to sign in" link.
 *
 * TODO (tomorrow): the rating page itself. Today this just lands the player
 * on /matches/[matchId]/rate as-is (the page exists but still has the
 * slider-based UI; we'll replace it with a tighter tap-through design in the
 * next session).
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";

interface PayloadPreview {
  purpose: "rate-match" | "sign-in";
  matchId?: string;
  nextPath?: string;
}

export default function MagicLinkLandingPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<"verifying" | "ok" | "error">("verifying");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!token) {
        setError("No token provided.");
        setState("error");
        return;
      }

      // Short-link support (2026-06-05): a legacy magic-link token always
      // contains a "." (payload.signature); a short code never does. If
      // there's no ".", resolve the code → its real token first. Old long
      // links contain a "." and skip this entirely, so they keep working.
      let realToken = token;
      if (!token.includes(".")) {
        try {
          const res = await fetch(`/api/r/${encodeURIComponent(token)}`);
          if (res.ok) {
            const data = await res.json();
            if (data?.token) realToken = data.token;
          }
        } catch {
          // fall through to the "couldn't resolve" check below
        }
        if (cancelled) return;
        if (realToken === token) {
          setError("This link isn't valid any more — it may have expired or already been used.");
          setState("error");
          return;
        }
      }

      // Peek at the payload without verifying — just so we know where to
      // redirect after sign-in. Actual verification is server-side.
      let preview: PayloadPreview | null = null;
      try {
        const body = realToken.split(".")[0];
        if (body) {
          const padded =
            body.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (body.length % 4)) % 4);
          const json = JSON.parse(atob(padded));
          preview = { purpose: json.purpose, matchId: json.matchId, nextPath: json.nextPath };
        }
      } catch {
        // No preview — continue, server will reject if invalid.
      }

      // Sign in via the magic-link credentials provider (server verifies).
      const result = await signIn("magic-link", { token: realToken, redirect: false });

      if (cancelled) return;

      if (result?.error || !result?.ok) {
        setError(
          "This link isn't valid any more — it may have expired or already been used.",
        );
        setState("error");
        return;
      }

      setState("ok");

      // Redirect based on intent.
      if (preview?.purpose === "rate-match" && preview.matchId) {
        router.replace(`/matches/${preview.matchId}/rate`);
      } else if (
        // Deep-link support for admin-specific DMs ("review provisional
        // members", "switch format", etc.). Only accept same-origin paths
        // that start with "/" — don't trust arbitrary URLs from token payloads.
        preview?.nextPath &&
        typeof preview.nextPath === "string" &&
        preview.nextPath.startsWith("/") &&
        !preview.nextPath.startsWith("//")
      ) {
        router.replace(preview.nextPath);
      } else {
        router.replace("/");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
        <h1 className="text-2xl font-bold text-slate-800">MatchTime</h1>

        {state === "verifying" && (
          <div className="mt-6">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-slate-500 mt-4">Signing you in…</p>
          </div>
        )}

        {state === "ok" && (
          <p className="text-sm text-slate-500 mt-4">Signed in — redirecting…</p>
        )}

        {state === "error" && (
          <div className="mt-6">
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
              {error}
            </div>
            <Link
              href="/login"
              className="inline-flex items-center justify-center mt-4 px-5 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
            >
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
