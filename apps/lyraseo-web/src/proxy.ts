import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { authSettings } from "./server/auth/settings";
import { readConfig } from "./server/config";
export async function proxy(request: NextRequest) {
  const settings = authSettings();
  if (settings) {
    let response = NextResponse.next({ request });
    const client = createServerClient(settings.url, settings.key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (values) => {
          for (const { name, value } of values)
            request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of values)
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: "lax",
              secure: settings.origin.startsWith("https:"),
            });
        },
      },
    });
    await client.auth.getClaims();
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }
  const { fixtureMode } = readConfig();
  const host = request.headers.get("host") ?? "";
  const hostIsLoopback =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    request.nextUrl.hostname,
  );
  // No unconfigured hosted access, including synthetic customer/staff routes.
  if (!fixtureMode || !loopback || !hostIsLoopback) {
    return new NextResponse(
      "Private pilot access is not configured. This deployment does not accept signups or run provider jobs.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
export const config = {
  matcher: [
    "/app/:path*",
    "/admin/:path*",
    "/api/:path*",
    "/sign-in",
    "/auth/:path*",
  ],
};
