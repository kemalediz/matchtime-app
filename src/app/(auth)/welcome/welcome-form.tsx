"use client";

import { useState } from "react";
import { completeOnboarding } from "@/app/actions/players";
import { t } from "@/lib/i18n/t";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import { ownPhoneError } from "@/lib/own-phone-copy";

export default function WelcomeForm({
  initialName,
  currentPhone,
}: {
  initialName: string;
  /** The stored number, if any: the sign-in number, shown read-only. */
  currentPhone: string | null;
}) {
  const s = t(useBrowserLang());
  const [name, setName] = useState(initialName);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError(s.own_err_name);

    setLoading(true);
    try {
      // With a stored number nothing is sent for it: the server keeps it.
      const res = await completeOnboarding({
        name: name.trim(),
        phoneNumber: currentPhone ? undefined : phoneNumber.trim() || undefined,
      });
      if (res && !res.ok) {
        setError(ownPhoneError(s, res.reason));
        setLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : s.own_err_generic);
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">{s.own_welcome_title}</h1>
          <p className="text-sm text-slate-500 mt-1">{s.own_welcome_intro}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1.5">
              {s.own_name_label}
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={s.own_name_placeholder}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-slate-700 mb-1.5">
              {s.own_phone_label}{" "}
              {!currentPhone && <span className="text-slate-400 font-normal">{s.own_phone_optional}</span>}
            </label>
            {currentPhone ? (
              <>
                <input
                  id="phone"
                  type="tel"
                  value={currentPhone}
                  readOnly
                  aria-readonly="true"
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 cursor-not-allowed"
                />
                <p className="text-xs text-slate-500 mt-1" data-testid="phone-signin-note">
                  {s.own_phone_signin_note}
                </p>
              </>
            ) : (
              <>
                <input
                  id="phone"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+44 7700 900000"
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-slate-400 mt-1">{s.own_phone_help}</p>
              </>
            )}
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? s.own_saving : s.own_welcome_submit}
          </button>
        </form>
      </div>
    </div>
  );
}
