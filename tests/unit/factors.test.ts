import { it, expect } from "vitest";
import { chooseVerifiedFactor } from "../../apps/lyraseo-web/src/server/auth/factors";
it("selects a verified backup authenticator and rejects unknown or unverified choices", () => {
  const factors = [
    { id: "primary", status: "verified" },
    { id: "backup", status: "verified" },
    { id: "pending", status: "unverified" },
  ];
  expect(chooseVerifiedFactor(factors, "backup")?.id).toBe("backup");
  expect(chooseVerifiedFactor(factors, "attacker")).toBeUndefined();
  expect(chooseVerifiedFactor(factors, "pending")).toBeUndefined();
  expect(chooseVerifiedFactor(factors, "")).toBeUndefined();
  expect(chooseVerifiedFactor(factors.slice(0, 1), "")?.id).toBe("primary");
});
