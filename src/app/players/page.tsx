import type { Metadata } from "next";
import { PLAYERS_PAGE } from "@/components/landing/landing-content";
import { PlayersPage } from "@/components/landing/players-page";
import { signupGoesOnEarlyListForPage } from "@/lib/pool/flags-page";

/**
 * /players: the website's page for players (2026-10-25). Public
 * (src/lib/public-paths.ts), no session data; the join button goes to
 * the /play sign-up with the page's source code.
 */
export const metadata: Metadata = {
  title: PLAYERS_PAGE.metaTitle,
  description: PLAYERS_PAGE.metaDescription,
};

export default async function Page() {
  return <PlayersPage earlyList={await signupGoesOnEarlyListForPage()} />;
}
