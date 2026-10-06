"use client";

/**
 * The organiser's buttons for one member of a month on /admin/months
 * (slice 3, plan 9.2): make them a regular (past the cap if need be),
 * move them to PAYG, or take them off the month. Submits to
 * `setMonthMember`, which checks the admin and the club again and writes
 * under the month's lock. Nothing here touches a payment.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMonthMember } from "@/app/actions/month-signup";
import { t } from "@/lib/i18n/t";

export function MemberActions(props: {
  orgId: string;
  monthId: string;
  userId: string;
  lang: string | null | undefined;
  /** What they are now: the matching button is not offered. */
  now: "regular" | "payg" | "waiting";
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function set(to: "regular" | "payg" | "out") {
    setSaving(true);
    try {
      const res = await setMonthMember(props.orgId, props.monthId, props.userId, to);
      if (!res.ok) toast.error(s.mth_act_error);
      router.refresh();
    } catch {
      toast.error(s.mth_act_error);
    } finally {
      setSaving(false);
    }
  }

  const button = "rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40";
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.now !== "regular" && (
        <button type="button" className={button} disabled={saving} onClick={() => set("regular")} data-testid="member-make-regular">
          {s.mth_act_regular}
        </button>
      )}
      {props.now !== "payg" && (
        <button type="button" className={button} disabled={saving} onClick={() => set("payg")} data-testid="member-make-payg">
          {s.mth_act_payg}
        </button>
      )}
      <button type="button" className={button} disabled={saving} onClick={() => set("out")} data-testid="member-remove">
        {s.mth_act_remove}
      </button>
    </div>
  );
}

/**
 * "Add a player" under a month's table (plan 9.2): a club player who is
 * not on the month, as a regular or as PAYG. The same action and the same
 * checks as the buttons above: the server refuses anybody who is not a
 * current player of this club.
 */
export function AddMember(props: {
  orgId: string;
  monthId: string;
  lang: string | null | undefined;
  /** The club's players who are not on this month. */
  players: { userId: string; name: string }[];
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [saving, setSaving] = useState(false);
  if (props.players.length === 0) return null;

  async function add(to: "regular" | "payg") {
    if (!userId) return;
    setSaving(true);
    try {
      const res = await setMonthMember(props.orgId, props.monthId, userId, to);
      if (!res.ok) toast.error(s.mth_act_error);
      else setUserId("");
      router.refresh();
    } catch {
      toast.error(s.mth_act_error);
    } finally {
      setSaving(false);
    }
  }

  const button = "h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="member-add">
      <select
        aria-label={s.mth_add_label}
        className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        data-testid="member-add-select"
      >
        <option value="">{s.mth_add_label}</option>
        {props.players.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" className={button} disabled={saving || !userId} onClick={() => add("regular")} data-testid="member-add-regular">
        {s.mth_add_regular}
      </button>
      <button type="button" className={button} disabled={saving || !userId} onClick={() => add("payg")} data-testid="member-add-payg">
        {s.mth_add_payg}
      </button>
    </div>
  );
}
