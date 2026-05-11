/**
 * Clears Spotify OAuth cookies (HttpOnly tokens). Clients call via POST after
 * the user taps Log out, then navigate to `/` so the app returns to landing.
 */
import { NextResponse } from "next/server";
import { clearMeSnapshotCookie } from "@/lib/server/meSnapshotCookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieOpts = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 0,
};

function buildLogoutResponse(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("svp_access_token", "", cookieOpts);
  res.cookies.set("svp_refresh_token", "", cookieOpts);
  clearMeSnapshotCookie(res);
  return res;
}

export async function POST() {
  return buildLogoutResponse();
}

export async function GET() {
  return buildLogoutResponse();
}
