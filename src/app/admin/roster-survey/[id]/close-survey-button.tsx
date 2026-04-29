"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Lock, Unlock } from "lucide-react";
import { closeSurvey, reopenSurvey } from "@/app/actions/roster-survey";

export function CloseSurveyButton({
  surveyId,
  status,
}: {
  surveyId: string;
  status: string;
}) {
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      try {
        if (status === "open") {
          await closeSurvey(surveyId);
          toast.success("Survey closed.");
        } else {
          await reopenSurvey(surveyId);
          toast.success("Survey reopened.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  if (status === "open") {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
        Close survey
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-sm font-medium disabled:opacity-50"
    >
      {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
      Reopen survey
    </button>
  );
}
