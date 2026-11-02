import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PublicTransport } from "../../packages/visibility/src/acquisition";

/** Controlled local website. Its public-looking URLs are mapped only by the test adapter. */
export async function crawlerSite() {
  let fixed = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    if (path === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end("User-agent: *\nDisallow: /blocked\n");
    }
    if (path === "/outside") {
      response.writeHead(302, { location: "https://outside.example/secret" });
      return response.end();
    }
    if (path === "/loop") {
      response.writeHead(302, { location: "/loop" });
      return response.end();
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "/" });
      return response.end();
    }
    if (path === "/missing" && !fixed) {
      response.writeHead(404, { "content-type": "text/html" });
      return response.end("Not found");
    }
    if (/^\/empty-(200|204|205)$/.test(path)) {
      response.writeHead(Number(path.slice(-3)), {
        "content-type": "text/html",
      });
      return response.end();
    }
    if (path === "/unicode") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(
        `<html><head><title>Unicode</title></head><body><a href="/about">${"a".repeat(499)}😀</a></body></html>`,
      );
    }
    if (path === "/unreadable") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(Buffer.from([255]));
    }
    if (path === "/nul") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(
        "<html><head><title>NUL</title></head><!--\u0000--></html>",
      );
    }
    if (path === "/text") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end("Plain text");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><head>${fixed ? "<title>Example product</title>" : "<title></title>"}<link rel="canonical" href="https://example.com${path}"></head><body><main><h1>Example</h1><p>Product details</p><a href="/about">About</a></main><script src="https://outside.example/tracker.js"></script><img src="http://169.254.169.254/secret"></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const transport: PublicTransport = async (url, signal) => {
    const parsed = new URL(url);
    if (parsed.origin !== "https://example.com")
      throw new Error("TEST_OUTSIDE_ORIGIN");
    const response = await fetch(
      `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`,
      { signal, redirect: "manual" },
    );
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    transport,
    requests,
    fix: () => {
      fixed = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
