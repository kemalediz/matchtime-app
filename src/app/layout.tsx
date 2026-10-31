import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/layout/app-shell";
import { WebAnalytics } from "@/components/web-analytics";
import { SITE_META } from "@/components/landing/landing-content";

// Inter for body copy — tightly hinted, great on every device at every
// size. `--font-geist-sans` kept as the CSS variable name so we don't
// have to touch every consumer; it just resolves to Inter now.
const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

// Plus Jakarta Sans for headings on the marketing surface — geometric,
// friendly, holds up at large sizes better than Inter Bold.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_META.title,
    template: "%s · MatchTime",
  },
  description: SITE_META.description,
  keywords: SITE_META.keywords,
  authors: [{ name: "Cressoft", url: "https://cressoft.io" }],
  creator: "Cressoft",
  publisher: "Cressoft",
  applicationName: "MatchTime",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "MatchTime",
    title: SITE_META.title,
    description: SITE_META.ogDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_META.title,
    description: SITE_META.ogDescription,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jakarta.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-slate-50 text-slate-800 font-sans">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        <WebAnalytics />
      </body>
    </html>
  );
}
