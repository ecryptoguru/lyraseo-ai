import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  chmod,
  symlink,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  localAuditArtifactStore as openLocalStore,
  faultAfterMutation,
  provisionLocalArtifactNamespace,
  type ArtifactVersion,
} from "../../packages/db/src/artifact-store";

let root: string;
let origin: string;
const openStores = new Set<Awaited<ReturnType<typeof openLocalStore>>>();
async function localAuditArtifactStore(
  ...args: Parameters<typeof openLocalStore>
) {
  const store = await openLocalStore(...args);
  openStores.add(store);
  return store;
}

const bytes = Buffer.from([239, 187, 191, 60, 1, 0, 255]);
const digest = createHash("sha256").update(bytes).digest("hex");
const version = (): ArtifactVersion => ({
  workspaceId: "a",
  storageKey: randomUUID(),
  generation: randomUUID(),
  codec: "IDENTITY",
  sourceLength: bytes.length,
  sourceHash: digest,
  storedLength: bytes.length,
  storedHash: digest,
  get origin() {
    return origin;
  },
});
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lyraseo-private-"));
  const provisioner = await openLocalStore(root);
  const physical = await provisionLocalArtifactNamespace(provisioner, "a");
  origin = JSON.stringify({
    ...physical,
    storeId: randomUUID(),
    namespaceId: randomUUID(),
    workspaceId: "a",
  });
  await provisioner.close();
});
afterEach(async () => {
  await Promise.all([...openStores].map((s) => s.close()));
  openStores.clear();
  await rm(root, { recursive: true, force: true });
});
it("recovers an uncertain put/delete on the same immutable scoped generation", async () => {
  const v = version(),
    store = await localAuditArtifactStore(root),
    faulty = faultAfterMutation(store, "put");
  await expect(faulty.putImmutable(v, bytes)).rejects.toThrow("UNCERTAIN");
  expect(await store.statVersion(v)).toBe(true);
  await store.putImmutable(v, bytes);
  expect(Buffer.from(await store.openBounded(v))).toEqual(bytes);
  await expect(store.putImmutable(v, Buffer.from("altered"))).rejects.toThrow();
  expect(await store.inventoryPage("b", null, 1)).toEqual([]);
  expect(await store.inventoryPage("a", null, 1)).toEqual([
    { storageKey: v.storageKey, generation: v.generation },
  ]);
  await expect(
    faultAfterMutation(store, "delete").deleteExactVersion(v),
  ).rejects.toThrow("UNCERTAIN");
  expect(await store.statVersion(v)).toBe(false);
  await store.deleteExactVersion(v);
  await expect(store.putImmutable(v, bytes)).rejects.toThrow();
  expect(await store.inventoryPage("a", null, 1)).toEqual([]);
});
it("rejects traversal, overflow, mismatched representation, corrupt files, symlinks and open roots", async () => {
  const v = version(),
    store = await localAuditArtifactStore(root);
  for (const bad of [
    { storageKey: "../escape" },
    { generation: "/tmp/escape" },
    { codec: "GZIP" },
    { sourceLength: 5242881 },
    { storedHash: "0".repeat(64) },
  ])
    await expect(
      store.putImmutable({ ...v, ...bad } as ArtifactVersion, bytes),
    ).rejects.toThrow();
  await store.putImmutable(v, bytes);
  const dir = join(root, createHash("sha256").update("a").digest("hex"));
  const name = (await readdir(dir))[0]!,
    file = join(dir, name);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await writeFile(file, Buffer.from("bad"));
  await expect(store.openBounded(v)).rejects.toThrow();
  await rm(file);
  await symlink("/etc/passwd", file);
  await expect(store.openBounded(v)).rejects.toThrow();
  await expect(store.deleteExactVersion(v)).rejects.toThrow();
  await expect(store.inventoryPage("a", null, 0)).rejects.toThrow();
  await chmod(root, 0o755);
  await expect(localAuditArtifactStore(root)).rejects.toThrow();
});

it("captures original bytes before decoding and attests the parsed facts against them", async () => {
  const { acquireRawPage, originalBody } =
    await import("../../packages/visibility/src/acquisition");
  const { attestArtifactReceipt } =
    await import("../../packages/db/src/artifact-checkpoint");
  const url = "https://example.com/",
    markup =
      '<html><head><title>Title</title></head><body><script type="application/ld+json">{"secret":"UNIQUE_PRIVATE"}</script></body></html>';
  for (const b of [
    Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(markup)]),
    Buffer.from([0xff]),
    Buffer.from([60, 0, 62]),
  ]) {
    const receipt = await acquireRawPage(url, url, async (address) =>
      address.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(b, { headers: { "content-type": "text/html" } }),
    );
    expect(Buffer.from(originalBody(receipt)!)).toEqual(b);
    expect(receipt.provenance.sha256).toBe(
      createHash("sha256").update(b).digest("hex"),
    );
    const checked = attestArtifactReceipt(
      {
        manifest: [url],
        profile: "CONTROLLED_RAW_TEST_V1",
        methodologyVersion: "readiness-v2",
      },
      receipt,
    );
    expect(JSON.stringify(checked.scratch)).not.toContain("UNIQUE_PRIVATE");
    if (receipt.evidence.acquired) {
      receipt.evidence.titleElements = ["forged"];
      expect(() =>
        attestArtifactReceipt(
          {
            manifest: [url],
            profile: "CONTROLLED_RAW_TEST_V1",
            methodologyVersion: "readiness-v2",
          },
          receipt,
        ),
      ).toThrow();
    }
  }
});

it("accepts exactly the byte cap, paginates opaque versions, and rejects unsafe namespaces", async () => {
  const store = await localAuditArtifactStore(root),
    data = Buffer.alloc(5 * 1024 * 1024, 127),
    sha = createHash("sha256").update(data).digest("hex");
  const v = {
    ...version(),
    sourceLength: data.length,
    storedLength: data.length,
    sourceHash: sha,
    storedHash: sha,
  };
  const next = { ...v, storageKey: randomUUID(), generation: randomUUID() };
  await store.putImmutable(v, data);
  await store.putImmutable(next, data);
  expect(await store.openBounded(v)).toHaveLength(data.length);
  const first = await store.inventoryPage("a", null, 1);
  expect(first).toHaveLength(1);
  expect(await store.inventoryPage("a", first[0]!, 1)).toHaveLength(1);
  const namespace = join(
    root,
    createHash("sha256").update("unsafe").digest("hex"),
  );
  await symlink(tmpdir(), namespace);
  await expect(store.inventoryPage("unsafe", null, 1)).rejects.toThrow();
  await expect(
    store.putImmutable({ ...v, workspaceId: "unsafe" }, data),
  ).rejects.toThrow();
});

it("does not publish a staging file before verification and atomically adopts a fully written uncertain generation", async () => {
  const store = await localAuditArtifactStore(root),
    v = version();
  // Reserve its namespace with an independent generation, as after a process crash before publish.
  await store.putImmutable(version(), bytes);
  const dir = join(root, createHash("sha256").update("a").digest("hex"));
  const staged = join(dir, v.storageKey + "." + v.generation);
  await writeFile(staged, bytes, { mode: 0o400 });
  expect(await store.statVersion(v)).toBe(false);
  await expect(store.openBounded(v)).rejects.toThrow();
  expect(await store.inventoryPage("a", null, 10)).not.toContainEqual({
    storageKey: v.storageKey,
    generation: v.generation,
  });
  await store.putImmutable(v, bytes);
  expect((await stat(staged)).mode & 0o777).toBe(0o600);
  expect(Buffer.from(await store.openBounded(v))).toEqual(bytes);
});

it.each(["put", "delete", "read", "inventory"] as const)(
  "round1 descriptor-confines %s across a workspace directory replacement",
  async (operation) => {
    const { rename } = await import("node:fs/promises");
    const outside = await mkdtemp(
      join(await realpath(tmpdir()), "lyraseo-race-out-"),
    );
    const original = await localAuditArtifactStore(root),
      v = version();
    await original.putImmutable(v, bytes);
    const namespace = join(
      root,
      createHash("sha256").update("a").digest("hex"),
    );
    let swapped = false;
    const racing = await localAuditArtifactStore(root, async () => {
      if (swapped) return;
      swapped = true;
      await rename(namespace, namespace + "-original");
      await symlink(outside, namespace);
    });
    try {
      const operations = {
        put: () =>
          racing.putImmutable({ ...v, storageKey: randomUUID() }, bytes),
        delete: () => racing.deleteExactVersion(v),
        read: () => racing.openBounded(v),
        inventory: () => racing.inventoryPage("a", null, 10),
      };
      const result = await operations[operation]().then(
        () => "ok",
        () => "failed",
      );
      expect(swapped).toBe(true);
      expect(await readdir(outside)).toEqual([]);
      expect(result).toBe("failed");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);

it("round1 closing waits for pinned work and rejects subsequent operations", async () => {
  let go!: () => void, ready!: () => void;
  const release = new Promise<void>((r) => {
      go = r;
    }),
    pinned = new Promise<void>((r) => {
      ready = r;
    });
  const v = version(),
    store = await localAuditArtifactStore(root, async () => {
      ready();
      await release;
    });
  const put = store.putImmutable(v, bytes);
  await pinned;
  const closed = store.close();
  await expect(store.statVersion(v)).rejects.toThrow("ARTIFACT_UNAVAILABLE");
  go();
  await put;
  await closed;
  await store.close();
});

it("origin inspection and read paths never initialize an unstamped namespace", async () => {
  const store = await localAuditArtifactStore(root),
    v = { ...version(), workspaceId: "unprovisioned", origin: undefined };
  const namespace = createHash("sha256").update(v.workspaceId).digest("hex");
  await mkdir(join(root, namespace), { mode: 0o700 });
  const before = await readdir(root);
  await store.statVersion(v).catch(() => false);
  await store.inventoryPage(v.workspaceId, null, 10).catch(() => []);
  await store.openBounded(v).catch(() => undefined);
  expect(await readdir(root)).toEqual(before);
  expect(await readdir(join(root, namespace))).toEqual([]);
});
