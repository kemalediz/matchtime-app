"use client";

/** The owner's two buttons on /admin/pool/safety (slice L7). English only. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { liftPoolPauseAction, markPoolReportReviewedAction } from "@/app/actions/pool-safety";

const BTN = "h-9 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";

function ActionButton(props: { label: string; testId: string; run: () => Promise<{ ok: boolean }> }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid={props.testId}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await props.run();
            setFailed(!r.ok);
            if (r.ok) router.refresh();
          })
        }
        className={BTN}
      >
        {props.label}
      </button>
      {failed && <span className="text-sm text-red-700">That did not work. Reload and try again.</span>}
    </span>
  );
}

export function ReviewedButton({ reportId }: { reportId: string }) {
  return <ActionButton label="Mark reviewed" testId="ps-reviewed" run={() => markPoolReportReviewedAction(reportId)} />;
}

export function LiftPauseButton({ userId }: { userId: string }) {
  return <ActionButton label="Lift the pause" testId="ps-lift" run={() => liftPoolPauseAction(userId)} />;
}
