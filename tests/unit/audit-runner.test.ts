import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Actor } from "../../packages/db/src/context";
import { isOriginalObservation } from "../../packages/visibility/src/acquisition";

const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  claimAuditRun: vi.fn(),
  readAuditProgress: vi.fn(),
  readAuditRun: vi.fn(),
  checkpointAuditPage: vi.fn(),
  checkpointPrivateAudit: vi.fn(),
  finishAuditRun: vi.fn(),
  yieldAuditRun: vi.fn(),
  lookup: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../../packages/db/src/audits", () => mocks);
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import { publicHttpsTransport } from "../../apps/lyraseo-web/src/server/acquisition/transport";

const actor: Actor = {
  userId: "user",
  sessionId: "session",
  securityVersion: 1,
  authenticatedAt: "2026-11-03T00:00:00Z",
  mfaVerified: false,
  authProvider: "supabase",
};
const scope = { workspaceId: "workspace", siteId: "site", auditId: "audit" };
const html =
  "<html><head><title>Observed source</title></head><body>Raw only</body></html>";
let state: {
  actor: Actor;
  epoch: number;
  suspended: boolean;
  granted: boolean;
  role: string;
  origin: string;
  verifiedAt: Date | null;
  status: string;
  fence: number;
  leaseOwner: string;
  leaseUntil: Date;
};
let queries: Array<{ text: string; values: unknown[] }>;
let sockets: string[];
let transactions: number;

// Exercise the real withActor/authorizeSiteIn; only database I/O and lifecycle
// writes are doubled. The prepare guard's rejection cases come from migrations
// 202611020017 and 202611030002, not a speculative browser check API.
const tx = {
  productUser: {
    findUnique: async () => ({
      id: actor.userId,
      suspended: state.suspended,
      securityVersion: state.epoch,
    }),
  },
  membership: { findUnique: async () => ({ role: state.role }) },
  workspace: { findUnique: async () => ({ deletedAt: null }) },
  site: {
    findUnique: async () => ({
      origin: state.origin,
      verifiedAt: state.verifiedAt,
      deletedAt: null,
    }),
  },
  auditRun: {
    findFirst: async () => ({
      id: scope.auditId,
      userId: actor.userId,
      securityVersion: state.epoch,
      profile: "LOCAL_RAW_V1",
      status: state.status,
      fence: state.fence,
      leaseOwner: state.leaseOwner,
      leaseUntil: state.leaseUntil,
      resultExpiresAt: new Date(Date.now() + 86400000),
    }),
  },
  $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?");
    queries.push({ text, values });
    if (text.includes("set_config")) {
      expect(values).toEqual(["user", "workspace"]);
      return [];
    }
    const permitted =
      ["OWNER", "ADMIN"].includes(state.role) ||
      (state.role === "EDITOR" && state.granted);
    if (text.includes("web_can_run")) return [{ allowed: permitted }];
    if (text.includes("web_transition")) {
      if (!text.includes("'prepare'::text"))
        throw new Error("Unexpected audit write during socket authorization");
      expect(values).toEqual(["site", "audit", 1, 7]);
      if (
        !permitted ||
        state.epoch !== actor.securityVersion ||
        state.suspended
      )
        throw new Error("FORBIDDEN");
      if (
        !state.verifiedAt ||
        +state.verifiedAt > Date.now() ||
        Date.now() - +state.verifiedAt > 86400000
      )
        throw new Error("SITE_NOT_VERIFIED");
      if (
        state.status !== "RUNNING" ||
        state.fence !== 7 ||
        +state.leaseUntil <= Date.now()
      )
        throw new Error("STALE_LEASE");
      return [{ id: scope.auditId }];
    }
    throw new Error(`Unexpected query: ${text}`);
  },
};
const db = {
  $transaction: async (work: (value: typeof tx) => Promise<unknown>) => {
    transactions++;
    try {
      return await work(tx);
    } finally {
      transactions--;
    }
  },
} as unknown as Parameters<typeof runRawAuditStep>[0];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transport(
  afterDns: (url: string) => Promise<void> = async () => {},
  response: (url: string) => Response = (url) =>
    url.endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response(html, { headers: { "content-type": "text/html" } }),
) {
  return async (
    url: string,
    signal: AbortSignal,
    beforeSocket?: () => Promise<void>,
  ) => {
    expect(transactions).toBe(0);
    await afterDns(url);
    if (beforeSocket) await beforeSocket();
    signal.throwIfAborted();
    expect(transactions).toBe(0);
    sockets.push(url);
    return response(url);
  };
}
const step = runRawAuditStep;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "audits");
  state = {
    actor: { ...actor },
    epoch: 1,
    suspended: false,
    granted: true,
    role: "EDITOR",
    origin: "https://example.com",
    verifiedAt: new Date(),
    status: "RUNNING",
    fence: 7,
    leaseOwner: "owned-lease",
    leaseUntil: new Date(Date.now() + 90000),
  };
  queries = [];
  sockets = [];
  transactions = 0;
  mocks.resolveActor.mockImplementation(async () => state.actor);
  mocks.claimAuditRun.mockResolvedValue({
    fence: 7,
    leaseOwner: "owned-lease",
    storageFormat: null,
  });
  mocks.readAuditProgress.mockResolvedValue({
    manifest: ["https://example.com/"],
    pages: [],
  });
  mocks.readAuditRun.mockResolvedValue({ id: "audit", status: "COMPLETED" });
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockImplementation((url: URL, _options, respond) => {
    expect(transactions).toBe(0);
    sockets.push(url.href);
    const policy = url.pathname === "/robots.txt";
    const incoming = Object.assign(new PassThrough(), {
      statusCode: policy ? 404 : 200,
      headers: policy ? {} : { "content-type": "text/html" },
    });
    return Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() => {
          respond(incoming);
          incoming.end(policy ? undefined : html);
        }),
    });
  });
});
afterEach(() => vi.unstubAllEnvs());

const changes: Array<[string, () => void]> = [
  [
    "user change",
    () => {
      state.actor = { ...actor, userId: "other" };
    },
  ],
  [
    "session change",
    () => {
      state.actor = { ...actor, sessionId: "other" };
    },
  ],
  [
    "security epoch change",
    () => {
      state.actor = { ...actor, securityVersion: 2 };
    },
  ],
  [
    "database epoch change",
    () => {
      state.epoch = 2;
    },
  ],
  [
    "account suspension",
    () => {
      state.suspended = true;
    },
  ],
  [
    "site grant revocation",
    () => {
      state.granted = false;
    },
  ],
  [
    "role downgrade",
    () => {
      state.role = "VIEWER";
    },
  ],
  [
    "capability pause",
    () => {
      vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
    },
  ],
  [
    "audit cancellation",
    () => {
      state.status = "FAILED";
      state.fence++;
    },
  ],
  [
    "fence replacement",
    () => {
      state.fence++;
    },
  ],
  [
    "lease expiry",
    () => {
      state.leaseUntil = new Date(Date.now() - 1);
    },
  ],
  [
    "lease owner replacement",
    () => {
      state.leaseOwner = "other";
    },
  ],
  [
    "verification revocation",
    () => {
      state.verifiedAt = null;
    },
  ],
  [
    "site origin change",
    () => {
      state.origin = "https://other.example";
    },
  ],
];
it.each(changes)(
  "blocks %s while DNS is pending, without checkpointing fabricated evidence",
  async (_name, change) => {
    const dnsStarted = deferred(),
      dnsReleased = deferred();
    mocks.lookup.mockImplementation(async () => {
      dnsStarted.resolve();
      await dnsReleased.promise;
      return [{ address: "93.184.216.34", family: 4 }];
    });
    const pending = step(
      db,
      actor,
      scope,
      publicHttpsTransport,
      mocks.resolveActor,
    );
    await dnsStarted.promise;
    change();
    dnsReleased.resolve();
    await expect(pending).rejects.toThrow();
    expect(sockets).toEqual([]);
    expect(mocks.checkpointAuditPage).not.toHaveBeenCalled();
    expect(mocks.checkpointPrivateAudit).not.toHaveBeenCalled();
    expect(mocks.finishAuditRun).not.toHaveBeenCalled();
  },
);

it("rechecks every robots/page redirect socket instead of caching admission", async () => {
  await expect(
    step(
      db,
      actor,
      scope,
      transport(
        async (url) => {
          if (url.endsWith("/final")) state.granted = false;
        },
        (url) => {
          if (url.endsWith("/robots.txt"))
            return new Response(null, {
              status: 302,
              headers: { location: "/policy" },
            });
          if (url.endsWith("/policy"))
            return new Response(null, { status: 404 });
          return new Response(null, {
            status: 302,
            headers: { location: "/final" },
          });
        },
      ),
      mocks.resolveActor,
    ),
  ).rejects.toThrow();
  expect(sockets).toEqual([
    "https://example.com/robots.txt",
    "https://example.com/policy",
    "https://example.com/",
  ]);
  expect(mocks.checkpointAuditPage).not.toHaveBeenCalled();
});

it.each([null, "AUDIT_PRIVATE_V1"])(
  "keeps authorized %s raw capture functional with original source hashes",
  async (storageFormat) => {
    mocks.claimAuditRun.mockResolvedValue({
      fence: 7,
      leaseOwner: "owned-lease",
      storageFormat,
    });
    await expect(
      step(db, actor, scope, publicHttpsTransport, mocks.resolveActor),
    ).resolves.toMatchObject({ id: "audit" });
    expect(sockets).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/",
    ]);
    expect(
      queries.filter((query) => query.text.includes("web_transition")).length,
    ).toBeGreaterThanOrEqual(2);
    const receipt = storageFormat
      ? mocks.checkpointPrivateAudit.mock.calls[0][4]
      : {
          evidence: mocks.checkpointAuditPage.mock.calls[0][4],
          provenance: mocks.checkpointAuditPage.mock.calls[0][5],
        };
    expect(receipt.evidence.acquired).toBe(true);
    expect(receipt.evidence.titleElements).toEqual(["Observed source"]);
    expect(receipt.evidence.headComplete).toBe(false);
    expect(receipt.evidence.bodyComplete).toBe(false);
    expect(receipt.provenance.rawHtml).toBe(html);
    expect(receipt.provenance.sha256).toBe(
      createHash("sha256").update(html).digest("hex"),
    );
    if (storageFormat) expect(isOriginalObservation(receipt)).toBe(true);
  },
);

it("does not start a socket after request cancellation during DNS", async () => {
  const controller = new AbortController();
  await expect(
    step(
      db,
      actor,
      scope,
      transport(async () => {
        controller.abort(new Error("REQUEST_CANCELLED"));
      }),
      mocks.resolveActor,
      controller.signal,
    ),
  ).rejects.toThrow("REQUEST_CANCELLED");
  expect(sockets).toEqual([]);
  expect(mocks.checkpointAuditPage).not.toHaveBeenCalled();
});

it("requires an explicit current-actor resolver, never a stale actor fallback", async () => {
  const unchecked = step as (...args: unknown[]) => Promise<unknown>;
  await expect(
    unchecked(db, actor, scope, publicHttpsTransport),
  ).rejects.toThrow("CURRENT_ACTOR_REQUIRED");
  expect(sockets).toEqual([]);
  expect(mocks.claimAuditRun).not.toHaveBeenCalled();
});

it("stops waiting for current actor resolution when the request cancels", async () => {
  const entered = deferred(),
    controller = new AbortController();
  mocks.resolveActor.mockImplementation(async () => {
    entered.resolve();
    return new Promise<Actor>(() => {});
  });
  const pending = step(
    db,
    actor,
    scope,
    publicHttpsTransport,
    mocks.resolveActor,
    controller.signal,
  );
  await entered.promise;
  controller.abort(new Error("REQUEST_CANCELLED"));
  const result = await Promise.race([
    pending.then(
      () => "completed",
      (error: Error) => error.message,
    ),
    new Promise<string>((done) => setTimeout(() => done("stuck"), 50)),
  ]);
  expect(result).toBe("REQUEST_CANCELLED");
  expect(sockets).toEqual([]);
  expect(mocks.checkpointAuditPage).not.toHaveBeenCalled();
});

it("fails closed if fresh actor resolution fails after DNS", async () => {
  await expect(
    step(
      db,
      actor,
      scope,
      transport(async () => {
        mocks.resolveActor.mockRejectedValue(new Error("UNAUTHENTICATED"));
      }),
      mocks.resolveActor,
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(sockets).toEqual([]);
  expect(mocks.checkpointAuditPage).not.toHaveBeenCalled();
});
