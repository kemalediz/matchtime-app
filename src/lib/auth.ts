import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "./db";
import bcrypt from "bcryptjs";
import { verifyMagicLinkToken } from "./magic-link";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await db.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user || !user.password) return null;
        if (!user.emailVerified) return null;

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
    // Magic-link provider — players sign in by opening a signed URL we
    // DM'd them on WhatsApp. No password needed. Used for the rating flow.
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
