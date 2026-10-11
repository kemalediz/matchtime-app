import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "./db";
import { verifyMagicLinkToken } from "./magic-link";
import { gateSignIn } from "./google-signin-gate";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // No email + password provider (removed 2026-10-11): WhatsApp is the
    // only sign-in the product shows, and no user has a password. Google
    // above is the platform owner's fallback at /login?via=google and is
    // held to already-linked accounts by `gateSignIn` below.
    // Magic-link provider: players sign in by opening a signed URL we
    // DM'd them on WhatsApp, and /login and /signup exchange a correct
    // WhatsApp code for a short-lived one.
    Credentials({
      id: "magic-link",
      name: "Magic Link",
      credentials: { token: { label: "Token", type: "text" } },
      async authorize(credentials) {
        const token = credentials?.token;
        if (!token || typeof token !== "string") return null;

        // Purpose allow-list is passed explicitly: only these two are
        // meant to establish a session. A narrower purpose added later
        // (e.g. a one-tap RSVP link) has to be opted in here rather than
        // silently minting a full session.
        const payload = await verifyMagicLinkToken(token, {
          purposes: ["sign-in", "rate-match"],
        });
        if (!payload) return null;

        const user = await db.user.findUnique({ where: { id: payload.userId } });
        if (!user) return null;

        // An admin link names the club it opens (2026-09-30), so an
        // organiser in two clubs lands in the right one.
        if (payload.orgId) {
          const { pinOrgFromMagicLink } = await import("./org");
          await pinOrgFromMagicLink(user.id, payload.orgId);
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    // Runs BEFORE Auth.js would create or link a user: an unknown Google
    // account is refused here and nothing is written.
    signIn: gateSignIn,
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
