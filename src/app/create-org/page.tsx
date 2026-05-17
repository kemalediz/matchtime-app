"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createOrganisation } from "@/app/actions/org";

function nameToSlug(name: string) {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export default function CreateOrgPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await createOrganisation({ name, slug });
      toast.success("Organisation created!");
      router.push("/admin/activities");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Create your organisation</h1>
          <p className="text-sm text-slate-500 mt-1">Set up your club, team, or group</p>
        </div>

        <Link
          href="/onboarding"
          className="block mb-6 p-4 rounded-xl border-2 border-blue-200 bg-blue-50 hover:border-blue-300 hover:bg-blue-100 transition-colors"
        >
          <p className="font-semibold text-blue-900 text-sm">
            ✨ Already running a WhatsApp group? Try the setup wizard →
          </p>
          <p className="text-xs text-blue-800/80 mt-1">
            Import your chat history to auto-detect players and get set up in a couple of minutes.
          </p>
        </Link>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Organisation name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(nameToSlug(e.target.value));
              }}
              placeholder="e.g. Sunday League FC"
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">URL</label>
            <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
              <span className="px-3 text-sm text-slate-500">matchtime.app/join/</span>
              <input
                type="text"
                value={slug}
                readOnly
                className="flex-1 h-11 bg-white border-l border-slate-200 px-3 text-slate-800"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? "Creating…" : "Create organisation"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Or{" "}
          <Link href="/" className="font-medium text-blue-600 hover:text-blue-700">
            join an existing organisation
          </Link>
        </p>
      </div>
    </div>
  );
}
