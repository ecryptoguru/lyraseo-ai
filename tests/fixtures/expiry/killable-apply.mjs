import { readFileSync } from "node:fs";
import { register } from "node:module";
register(
  new URL("../../../scripts/privacy-ts-loader.mjs", import.meta.url),
  import.meta.url,
);
const { createDatabase } = await import("../../../packages/db/src/index.ts");
const { localAuditArtifactStore, localArtifactFaultFacade } =
  await import("../../../packages/db/src/artifact-store.ts");
const { bindLocalExpiryAuthority, applyPrivateArtifactExpiry } =
  await import("../../../packages/db/src/artifact-expiry.ts");
const config = JSON.parse(readFileSync(3, "utf8"));
const db = createDatabase(config.databaseUrl);
const underlying = await localAuditArtifactStore(config.root);
const pause = async (kind) => {
  if (kind !== config.operation) return;
  process.stdout.write("BOUNDARY\n");
  await new Promise(() => {});
};
const store = localArtifactFaultFacade(underlying, { [config.phase]: pause });
bindLocalExpiryAuthority(store, {
  keyId: config.keyId,
  secret: Buffer.from(config.secretHex, "hex"),
  scope: { workspaceId: config.workspaceId, siteId: config.siteId },
  origin: config.origin,
});
await applyPrivateArtifactExpiry(
  db,
  store,
  { workspaceId: config.workspaceId, siteId: config.siteId },
  config.planId,
  config.hash,
);
throw Error("BOUNDARY_NOT_REACHED");
