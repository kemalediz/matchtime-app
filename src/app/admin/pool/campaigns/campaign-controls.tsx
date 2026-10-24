"use client";

/**
 * The owner's source-code controls (pool slice G1): the new-code form, the
 * on/off switch and Copy link. Owner pages are English, as /admin/clubs.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPoolCampaignAction, setPoolCampaignActiveAction } from "@/app/actions/pool-campaigns";

const BTN = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60";

const CODE_ERROR: Record<string, string> = {
  required: "Give the code a name.",
  format: "Lowercase letters, digits and single hyphens only, for example leaflet-sutton-oct.",
  "too-long": "That code is too long.",
};
const LABEL_ERROR: Record<string, string> = { required: "Say what this code is for.", "too-long": "That description is too long." };

export function NewCampaignForm({ sources, codeMax, labelMax }: { sources: { value: string; label: string }[]; codeMax: number; labelMax: number }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [source, setSource] = useState(sources[0]?.value ?? "");
  const [label, setLabel] = useState("");
  const [errors, setErrors] = useState<{ code?: string; label?: string; form?: string }>({});
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDone(null);
    start(async () => {
      const r = await createPoolCampaignAction({ code, source, label });
      if (r.ok) {
        setErrors({});
        setDone(r.code);
        setCode("");
        setLabel("");
        router.refresh();
      } else if ("errors" in r) {
        setErrors({
          code: r.errors.code ? CODE_ERROR[r.errors.code] : undefined,
          label: r.errors.label ? LABEL_ERROR[r.errors.label] : undefined,
          form: r.errors.source ? "Pick where you will share it." : undefined,
        });
      } else setErrors({ form: r.reason === "taken" ? "That code is taken. Pick another." : "Only the platform owner can make codes." });
    });
  };

  return (
    <form onSubmit={submit} aria-labelledby="new-code" className="rounded-xl border border-slate-200 bg-slate-50 p-4" noValidate>
      <h3 id="new-code" className="text-base font-semibold text-slate-900">
        New code
      </h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <div className="text-sm">
          <label htmlFor="campaign-code" className="font-medium text-slate-900">
            Code
          </label>
          <input
            id="campaign-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={codeMax}
            placeholder="leaflet-sutton-oct"
            aria-invalid={!!errors.code}
            aria-describedby={errors.code ? "campaign-code-error" : undefined}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono"
          />
          {errors.code && (
            <p id="campaign-code-error" className="mt-1 text-red-700">
              {errors.code}
            </p>
          )}
        </div>
        <label className="block text-sm">
          <span className="font-medium text-slate-900">Where it is shared</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
            {sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="text-sm">
          <label htmlFor="campaign-label" className="font-medium text-slate-900">
            What it is for
          </label>
          <input
            id="campaign-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={labelMax}
            placeholder="Sutton leaflets, October"
            aria-invalid={!!errors.label}
            aria-describedby={errors.label ? "campaign-label-error" : undefined}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          />
          {errors.label && (
            <p id="campaign-label-error" className="mt-1 text-red-700">
              {errors.label}
            </p>
          )}
        </div>
      </div>
      {errors.form && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-700">
          {errors.form}
        </p>
      )}
      {done && (
        <p role="status" className="mt-3 text-sm font-medium text-emerald-800">
          Code {done} is ready.
        </p>
      )}
      <button type="submit" disabled={pending} className={`${BTN} mt-4 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}>
        {pending ? "Making it" : "Make code"}
      </button>
    </form>
  );
}

export function CampaignActiveToggle({ code, active }: { code: string; active: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(active);
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm text-slate-800">
      <input
        type="checkbox"
        role="switch"
        aria-label={`Code ${code} on`}
        className="h-5 w-5"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          start(async () => {
            const r = await setPoolCampaignActiveAction(code, next);
            if (!r.ok) setOn(!next);
            router.refresh();
          });
        }}
      />
      {on ? "On" : "Off"}
    </label>
  );
}

export function CampaignCopyLink({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className="font-semibold text-blue-700 underline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setState("done");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Could not copy" : "Copy link"}
    </button>
  );
}
