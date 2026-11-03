import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  realpath,
  rm,
  cp,
  rename,
  symlink,
  readdir,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localAuditArtifactStore,
  provisionLocalArtifactNamespace,
  assertLocalArtifactOrigin,
  localArtifactFaultFacade,
  type AuditArtifactStore,
  type ArtifactVersion,
} from "../../packages/db/src/artifact-store";
const roots: string[] = [],
  stores: AuditArtifactStore[] = [];
async function root() {
  const value = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-origin-"),
  );
  roots.push(value);
  return value;
}
async function open(path: string) {
  const store = await localAuditArtifactStore(path);
  stores.push(store);
  return store;
}
async function enrolled() {
  const path = await root(),
    store = await open(path),
    physical = await provisionLocalArtifactNamespace(store, "a");
  const origin = JSON.stringify({
    ...physical,
    workspaceId: "a",
    storeId: randomUUID(),
    namespaceId: randomUUID(),
  });
  return { path, store, origin };
}
const hash = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const bytes = Buffer.from("original-origin-bytes");
function version(origin?: string): ArtifactVersion {
  return {
    workspaceId: "a",
    storageKey: randomUUID(),
    generation: randomUUID(),
    codec: "IDENTITY",
    sourceHash: hash(bytes),
    storedHash: hash(bytes),
    sourceLength: bytes.length,
    storedLength: bytes.length,
    ...(origin ? { origin } : {}),
  };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("construction and missing/incomplete namespace inspection make zero filesystem changes", async () => {
  const path = await root(),
    store = await open(path);
  expect(await readdir(path)).toEqual([]);
  await expect(store.inspectOrigin("a")).rejects.toThrow();
  expect(await store.statVersion(version())).toBe(false);
  expect(await store.inventoryPage("a", null, 1)).toEqual([]);
  await expect(store.deleteExactVersion(version())).rejects.toThrow();
  expect(await readdir(path)).toEqual([]);
  const namespace = hash("a");
  await mkdir(join(path, namespace), { mode: 0o700 });
  const before = await readdir(path);
  await expect(store.inspectOrigin("a")).rejects.toThrow();
  await store.statVersion(version()).catch(() => false);
  await expect(provisionLocalArtifactNamespace(store, "a")).rejects.toThrow();
  expect((await readdir(path)).filter((x) => x !== ".store-origin-v1")).toEqual(
    before,
  );
  expect(await readdir(join(path, namespace))).toEqual([]);
});
it("a fabricated backend, copied public descriptor and spread local store cannot inherit a witness", async () => {
  const { store, origin } = await enrolled();
  const publicDescriptor = await store.inspectOrigin("a");
  await assertLocalArtifactOrigin(store, "a", origin);
  const copied = {
    ...store,
    inspectOrigin: async () => structuredClone(publicDescriptor),
  };
  await expect(assertLocalArtifactOrigin(copied, "a", origin)).rejects.toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
  expect(() => localArtifactFaultFacade(copied, {})).toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
  await expect(store.putImmutable(version(), bytes)).rejects.toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
  await expect(
    assertLocalArtifactOrigin(
      store,
      "a",
      JSON.stringify({
        ...JSON.parse(origin),
        assertionVersion: "STORE_ORIGIN_V0",
      }),
    ),
  ).rejects.toThrow();
});
it("the fixed fault facade keeps delegate origin but actual corrupted/truncated bytes remain visible", async () => {
  const { store, origin } = await enrolled(),
    v = version(origin);
  for (const mode of ["flip", "truncate", "zeros"] as const) {
    const facade = localArtifactFaultFacade(store, { readMutation: mode });
    expect(Object.isFrozen(facade)).toBe(true);
    await assertLocalArtifactOrigin(facade, "a", origin);
    await facade.putImmutable(v, bytes);
    expect(Buffer.from(await facade.openBounded(v))).not.toEqual(bytes);
    expect(Buffer.from(await store.openBounded(v))).toEqual(bytes);
  }
});
it.each(["empty", "copy", "replace", "symlink"] as const)(
  "real %s root cannot qualify as the original registered store",
  async (kind) => {
    const { path, store, origin } = await enrolled();
    const other = await root();
    if (kind === "empty") {
      const wrong = await open(other);
      await provisionLocalArtifactNamespace(wrong, "a");
      await expect(
        assertLocalArtifactOrigin(wrong, "a", origin),
      ).rejects.toThrow();
      return;
    }
    if (kind === "copy") {
      await cp(path, other, { recursive: true, force: true });
      const copy = await open(other);
      await expect(
        assertLocalArtifactOrigin(copy, "a", origin),
      ).rejects.toThrow();
      return;
    }
    const old = path + "-old";
    roots.push(old);
    await rename(path, old);
    if (kind === "replace") await mkdir(path, { mode: 0o700 });
    else await symlink(other, path);
    await expect(
      assertLocalArtifactOrigin(store, "a", origin),
    ).rejects.toThrow();
  },
);
it.each(["copy", "replace", "symlink", "stamp"] as const)(
  "real namespace %s invalidates origin before any selected put",
  async (kind) => {
    const { path, store, origin } = await enrolled(),
      namespace = join(path, hash("a")),
      v = version(origin);
    if (kind === "stamp") {
      const stamp = join(path, "." + hash("a") + ".identity"),
        content = await readFile(stamp);
      await rename(stamp, stamp + "-old");
      await writeFile(stamp, content, { mode: 0o600 });
    } else {
      await rename(namespace, namespace + "-old");
      if (kind === "copy")
        await cp(namespace + "-old", namespace, { recursive: true });
      if (kind === "replace") await mkdir(namespace, { mode: 0o700 });
      if (kind === "symlink") await symlink(await root(), namespace);
    }
    await expect(
      assertLocalArtifactOrigin(store, "a", origin),
    ).rejects.toThrow();
    await expect(store.putImmutable(v, bytes)).rejects.toThrow();
    expect(await readdir(namespace + (kind === "stamp" ? "" : "-old"))).toEqual(
      [],
    );
  },
);

it("successful enrolled inspection/read/dry inventory preserves every filesystem identity, content and write clock", async () => {
  const { path, store, origin } = await enrolled();
  async function snapshot(path_: string): Promise<unknown> {
    const info = await lstat(path_, { bigint: true });
    return {
      dev: String(info.dev),
      ino: String(info.ino),
      mode: String(info.mode),
      mtime: String(info.mtimeNs),
      ctime: String(info.ctimeNs),
      ...(info.isDirectory()
        ? {
            entries: await Promise.all(
              (await readdir(path_))
                .sort()
                .map(async (name) => [name, await snapshot(join(path_, name))]),
            ),
          }
        : { hash: hash(await readFile(path_)) }),
    };
  }
  const before = await snapshot(path),
    v = version(origin);
  await store.inspectOrigin("a");
  await assertLocalArtifactOrigin(store, "a", origin);
  expect(await store.statVersion(v)).toBe(false);
  expect(await store.inventoryPage("a", null, 10)).toEqual([]);
  await expect(store.openBounded(v)).rejects.toThrow();
  expect(await snapshot(path)).toEqual(before);
});
it("explicit provisioning refuses a root-only copied instance marker", async () => {
  const original = await root(),
    source = await open(original);
  await provisionLocalArtifactNamespace(source, "a");
  const target = await root();
  await cp(
    join(original, ".store-origin-v1"),
    join(target, ".store-origin-v1"),
  );
  const copied = await open(target),
    before = await readdir(target);
  await expect(
    provisionLocalArtifactNamespace(copied, "new-workspace"),
  ).rejects.toThrow();
  expect(await readdir(target)).toEqual(before);
});
