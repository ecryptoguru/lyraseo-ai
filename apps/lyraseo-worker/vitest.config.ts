import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import {
  createTestMapper,
  readIssuedPins,
} from "../../scripts/lib/worker-test-mapper.mjs";
const outbound = createTestMapper({
  bridgeOrigin: process.env.LYRA_WORKER_BRIDGE,
  controlOrigin: process.env.LYRA_WORKER_CONTROL,
  readPins: () => readIssuedPins(process.env.LYRA_WORKER_PINS_PATH),
});
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "local" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_BRIDGE_SECRET: process.env.LYRA_WORKER_SECRET ?? "",
          TEST_ROTATED_BRIDGE_SECRET:
            process.env.LYRA_WORKER_ROTATED_SECRET ?? "",
        },
        serviceBindings: { DLQ_CAPTURE: "dlq-capture" },
        workers: [
          {
            name: "dlq-capture",
            compatibilityDate: "2026-11-02",
            modules: true,
            script: `let messages=[];export default {queue(batch){for(const m of batch.messages){messages.push(m.body);m.ack();}},fetch(){return Response.json(messages.splice(0));}}`,
            queueConsumers: {
              "lyraseo-carrier-local-dlq": {
                maxBatchSize: 1,
                maxBatchTimeout: 0,
              },
            },
          },
        ],
        // Node-only mapper, no production loopback exception and no generic proxy.
        outboundService: outbound,
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
