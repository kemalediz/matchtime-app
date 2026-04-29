"use client";

import { useTransition } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { overrideResponse } from "@/app/actions/roster-survey";

type Resp = "in" | "maybe" | "out" | "unclear";

const PILL: Record<Resp | "pending", { label: string; cls: string }> = {
  in: { label: "✅ In", cls: "bg-green-100 text-green-700" },
  maybe: { label: "🤔 Maybe", cls: "bg-amber-100 text-amber-700" },
  out: { label: "👋 Out", cls: "bg-slate-200 text-slate-700" },
  unclear: { label: "🤷 Unclear", cls: "bg-slate-100 text-slate-600" },
  pending: { label: "⏳ Pending", cls: "bg-slate-50 text-slate-500 border border-slate-200" },
};

export function ResponseRow({
  surveyId,
  userId,
  name,
  phone,
  response,
  rawReply,
  adminOverride,
  respondedAt,
}: {
  surveyId: string;
  userId: string;
  name: string;
  phone: string;
  response: string | null;
  rawReply: string | null;
  adminOverride: boolean;
  respondedAt: Date | null;
}) {
  const [pending, start] = useTransition();
  const status = (response as Resp | null) ?? "pending";
  const pill = PILL[status];

  function setOverride(next: Resp) {
    start(async () => {
      try {
        await overrideResponse({ surveyId, userId, response: next });
        toast.success(`Set ${name} to ${next}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  return (
    <div className="px-6 py-4 grid grid-cols-[1fr_120px_1.5fr_220px] gap-4 items-start">
      <div>
        <p className="font-medium text-slate-800">{name}</p>
        <p className="text-xs text-slate-500 mt-0.5">{phone || "(no phone)"}</p>
      </div>
      <div>
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${pill.cls}`}>
          {pill.label}
        </span>
        {adminOverride && (
          <p className="text-[10px] text-slate-400 mt-1">admin-set</p>
        )}
        {respondedAt && (
          <p className="text-[10px] text-slate-400 mt-1">
            {format(respondedAt, "d MMM HH:mm")}
          </p>
        )}
      </div>
      <div>
        {rawReply ? (
          <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">
            {rawReply}
          </p>
        ) : (
          <p className="text-sm text-slate-300 italic">No reply yet</p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 justify-end">
        {(["in", "maybe", "out", "unclear"] as Resp[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setOverride(r)}
            disabled={pending || status === r}
            className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
              status === r
                ? "bg-slate-100 border-slate-300 text-slate-500 cursor-default"
                : "bg-white border-slate-200 hover:bg-slate-50 text-slate-700"
            }`}
            title={`Set as ${r}`}
          >
            {pending && status !== r ? <Loader2 className="w-3 h-3 animate-spin" /> : r}
          </button>
        ))}
      </div>
    </div>
  );
}
