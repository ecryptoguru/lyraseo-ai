import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LOCAL_GRANT_BOOTSTRAP } from "../../scripts/lib/local-grants.mjs";

it("sends the authoritative current grant SQL to the role gate despite a stale local-db decoy", async () => {
  const actualRead = readFileSync;
  const decoy = "DECOY_STALE_REPORT_BOOTSTRAP";
  let reportAttempts = 0;
  let captured = "";
  let stop = false;
  vi.doMock("node:fs", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs")>();
    return {
      ...fs,
      readFileSync: (...args: Parameters<typeof readFileSync>) => {
        if (args[0] === "scripts/local-db.mjs")
          return `${actualRead(args[0], "utf8")}\nconst sql = \`GRANT USAGE ON SCHEMA public TO lyraseo_identity; ${decoy}\`;`;
        return (actualRead as (...values: unknown[]) => unknown)(...args);
      },
    };
  });
  vi.doMock("node:child_process", () => ({
    spawn: vi.fn(),
    spawnSync: (_cmd: string, args: string[], options?: { input?: string }) => {
      if (args[0] === "inspect")
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Config: { Image: "postgres:17-alpine" },
              HostConfig: {
                PortBindings: {
                  "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }],
                },
              },
            },
          ]),
        };
      if (args.includes("mktemp"))
        return { status: 0, stdout: "/tmp/lyraseo-report-role-test123" };
      if (!args.includes("psql")) return { status: 0, stdout: "" };
      const input = options?.input ?? "";
      if (stop) throw Error("HARNESS_STOP_AFTER_CAPTURE");
      if (input.includes("Duplicate','saved-evidence-v2"))
        return { status: 1, stderr: "duplicate key" };
      if (
        input ===
        actualRead(
          "packages/db/prisma/migrations/202611030013_legacy_saved_evidence/migration.sql",
          "utf8",
        )
      ) {
        reportAttempts++;
        return reportAttempts === 1
          ? { status: 1, stderr: "UNSAFE_REPORT_PAYLOAD_PRIVILEGE" }
          : { status: 0, stdout: "" };
      }
      if (input.startsWith("BEGIN;\n") && input.endsWith("\nCOMMIT;")) {
        captured = input;
        stop = true;
        return { status: 1, stderr: "UNSAFE_REPORT_PAYLOAD_PRIVILEGE" };
      }
      if (input.includes("has_column_privilege"))
        return { status: 0, stdout: "t" };
      if (input.includes("octet_length(pdf)"))
        return { status: 0, stdout: "5" };
      return { status: 0, stdout: "" };
    },
  }));
  try {
    await expect(
      import("../../scripts/test-legacy-report-role-isolation.mjs"),
    ).rejects.toThrow("HARNESS_STOP_AFTER_CAPTURE");
    expect(captured).toBe(`BEGIN;\n${LOCAL_GRANT_BOOTSTRAP}\nCOMMIT;`);
    expect(captured).not.toContain(decoy);
  } finally {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});
