import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { PublicTransport } from "../../packages/visibility/src/acquisition";

export const fixtureOrigin = "https://crawler-fixture.example/";
const healthy = (path: string) =>
  `<!doctype html><html lang="en"><head><title>Controlled product</title><link rel="canonical" href="${fixtureOrigin.slice(0, -1)}${path}"></head><body><main><h1>Controlled product</h1><p>Healthy source.</p><a href="/about">About</a></main></body></html>`;

/** An actual HTTP server behind the existing injected transport seam only.
 * Production public HTTPS/DNS policy is never changed to admit this loopback site.
 */
export async function crawlerContractSite(
  options: { robotsStatus?: number; robotsBody?: string } = {},
) {
  let fixed = false;
  const requests: string[] = [];
  const waiters = new Map<string, Array<() => void>>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    for (const notify of waiters.get(path) ?? []) notify();
    waiters.delete(path);
    if (path === "/robots.txt") {
      response.writeHead(options.robotsStatus ?? 200, {
        "content-type": "text/plain; charset=utf-8",
      });
      return response.end(
        options.robotsBody ?? "User-agent: *\nDisallow: /blocked\n",
      );
    }
    const redirect = (location: string) => {
      response.writeHead(302, { location });
      response.end();
    };
    if (path === "/outside")
      return redirect("https://outside.example/credential-canary");
    if (path === "/downgrade")
      return redirect("http://crawler-fixture.example/plain");
    if (path === "/metadata")
      return redirect("http://169.254.169.254/latest/meta-data/");
    if (path === "/invalid-target") return redirect("https://[");
    if (path === "/credential-target")
      return redirect(
        "https://fixture-user:fixture-pass@crawler-fixture.example/private",
      );
    if (path === "/loop-a") return redirect("/loop-b");
    if (path === "/loop-b") return redirect("/loop-a");
    if (path === "/into-blocked") return redirect("/blocked");
    if (path === "/duplicate-a" || path === "/duplicate-b")
      return redirect("/healthy");
    const chain = /^\/chain\/(\d+)$/.exec(path);
    if (chain && Number(chain[1]) > 0)
      return redirect(`/chain/${Number(chain[1]) - 1}`);
    if (path === "/hang") return;
    const status = /^\/status\/(403|404|429|500|503)$/.exec(path);
    if (status || (path === "/repair" && !fixed)) {
      response.writeHead(status ? Number(status[1]) : 404, {
        "content-type": "text/html",
      });
      return response.end("<p>Known HTTP failure</p>");
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/oversized") {
      response.writeHead(200);
      return response.end(Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    }
    if (path === "/truncated") {
      response.writeHead(200, { "content-length": "1000000" });
      return response.write("<html>", () => response.destroy());
    }
    if (path === "/unreadable" || (path === "/removed" && fixed))
      return response.end(Buffer.from([0xff]));
    if (path === "/empty") return response.end();
    if (path === "/encoded") {
      response.setHeader("content-encoding", "gzip");
      // These actual gzip bytes are returned untouched by the Node fixture
      // adapter below; a fetch adapter would transparently decompress them.
      return response.end(
        Buffer.from(
          "H4sIAAAAAAAAA7PJKMnNsbNJyk+ptDPJSbVLzSspykzJTE0sBgAHeGE4GQAAAA==",
          "base64",
        ),
      );
    }
    if (path === "/malformed")
      return response.end(
        "<html><head><title>Malformed but parseable</title></head><body><main><p>Open elements",
      );
    if (path === "/js-shell")
      return response.end(
        '<html><head></head><body><div id="app"></div><script>document.title="Rendered title";document.getElementById("app").innerHTML="<main><h1>Rendered heading</h1></main>";fetch("https://outside.example/script-canary");new WebSocket("wss://outside.example/socket-canary");</script><iframe src="http://169.254.169.254/frame-canary"></iframe><style>@import "https://outside.example/css-canary";</style></body></html>',
      );
    if (path === "/header-conflict") {
      response.setHeader("x-robots-tag", "googlebot: noindex");
      response.setHeader(
        "link",
        `<${fixtureOrigin}different>; rel="canonical"`,
      );
    }
    response.end(healthy(path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const transport: PublicTransport = async (url, signal) => {
    const target = new URL(url);
    if (target.origin !== new URL(fixtureOrigin).origin)
      throw new Error("TEST_OUTSIDE_ORIGIN");
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${port}${target.pathname}${target.search}`,
        { signal, agent: false },
        (incoming) => {
          const headers = new Headers();
          for (const [name, values] of Object.entries(incoming.headers))
            if (values !== undefined)
              headers.set(
                name,
                Array.isArray(values) ? values.join(", ") : values,
              );
          const status = incoming.statusCode!;
          if ([204, 205, 304].includes(status)) incoming.resume();
          // No redirect following or transparent decompression. The different
          // loopback URL is mapped only by this approved fixture adapter.
          resolve(
            new Response(
              [204, 205, 304].includes(status)
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
  };
  return {
    requests,
    transport,
    fix: () => {
      fixed = true;
    },
    requested: (path: string) =>
      requests.includes(path)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.set(path, [...(waiters.get(path) ?? []), resolve]);
          }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
