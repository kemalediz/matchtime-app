import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { loadPoolManageView } from "@/lib/pool/manage";
import { POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { ManageView } from "./manage-view";

/**
 * /play/manage: the person's own player pool profile (slice L2). He gets
 * here by the signed link in MatchTime's WhatsApp reply (lib/pool/links.ts),
 * which signs him in. Pause, resume, edit everything, stop, start again,
 * the badge privacy switch, delete.
 */
export const metadata: Metadata = { title: poolPageCopy("en").manage.heading, robots: { index: false, follow: false } };

export default async function ManagePage() {
  const userId = (await auth())?.user?.id;
  if (!userId) redirect(`/login?callbackUrl=${encodeURIComponent(POOL_MANAGE_PATH)}`);
  const view = await loadPoolManageView(userId);
  return <ManageView view={view} />;
}
