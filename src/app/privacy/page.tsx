import type { Metadata } from "next";
import { privacyPolicy } from "@/lib/i18n/privacy-policy";
import { PrivacyPolicyView } from "./privacy-policy-view";

/**
 * The privacy policy (local player pool, slice L0). Public, no session
 * data. The wording is in `src/lib/i18n/privacy-policy.*.ts`; the page
 * follows the visitor's browser language and has a switch.
 */
const en = privacyPolicy("en");

export const metadata: Metadata = {
  title: en.title,
  description: en.lead,
};

export default function PrivacyPage() {
  return <PrivacyPolicyView />;
}
