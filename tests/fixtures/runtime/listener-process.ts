// Controlled subprocess for crash/restart acceptance. Its only transport is a
// synthetic local HTML response; it receives the ephemeral test key over IPC.
import { createDatabase } from "../../../packages/db/src";
import { runtimePaths } from "../../../packages/contracts/src/runtime-signing";
import { createControlledFixture } from "../../../apps/lyraseo-web/src/server/runtime/fixture";
import { startControlledRuntime } from "../../../apps/lyraseo-web/src/server/runtime/listener";
import { adminUrl } from "../../helpers/database";

type PrivateFixture = { root: string; keyId: string; verifier: string };
process.once(
  "message",
  async ({
    secret,
    artifact,
  }: {
    secret: string;
    artifact?: PrivateFixture;
  }) => {
    const url = new URL(adminUrl);
    url.username = "lyraseo_dispatch";
    url.password = "local_dispatch_only";
    const db = createDatabase(url.href);
    if (artifact) {
      const { bindLocalArtifactStore } =
        await import("../../../packages/db/src/artifact-checkpoint");
      const { localAuditArtifactStore } =
        await import("../../../packages/db/src/artifact-store");
      bindLocalArtifactStore(db, await localAuditArtifactStore(artifact.root), {
        keyId: artifact.keyId,
        secret: new Uint8Array(Buffer.from(artifact.verifier, "base64")),
      });
    }
    const runtime = await startControlledRuntime({
      db,
      keys: () => [
        {
          id: "original",
          principal: "lyraseo_dispatch",
          audience: "lyraseo-kernel-a",
          actions: runtimePaths,
          secret: new Uint8Array(Buffer.from(secret, "base64")),
        },
      ],
      fixture: createControlledFixture(
        "https://example.com",
        async (url, signal) => {
          signal.throwIfAborted();
          process.send?.({ event: "fixture-hop" });
          return url.endsWith("robots.txt")
            ? new Response(null, { status: 404 })
            : new Response("<html>Observed fixture</html>", {
                headers: { "Content-Type": "text/html" },
              });
        },
      ),
    });
    process.send?.({ event: "ready", origin: runtime.origin });
  },
);
process.send?.({ event: "configure" });
