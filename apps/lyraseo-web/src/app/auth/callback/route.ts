import { NextResponse } from "next/server";
import { authClient } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
export async function GET(request: Request) {
  const settings = authSettings();
  if (!settings)
    return new Response("Private sign-in is not configured.", { status: 503 });
  const code = new URL(request.url).searchParams.get("code");
  if (code) {
    try {
      const { error } = await (
        await authClient()
      ).auth.exchangeCodeForSession(code);
      if (!error)
        return NextResponse.redirect(`${settings.origin}/app/workspaces`);
    } catch {
      // A provider outage should return the user to a recoverable sign-in state.
    }
  }
  return NextResponse.redirect(`${settings.origin}/sign-in?error=callback`);
}
