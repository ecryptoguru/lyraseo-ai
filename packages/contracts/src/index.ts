import { z } from "zod";

export const siteOriginSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.port
    );
  } catch {
    return false;
  }
}, "Enter a public HTTPS origin without credentials or a custom port.");

export const auditRequestSchema = z.strictObject({
  siteId: z.string().min(1),
  urls: z.array(siteOriginSchema).min(1).max(25),
  methodologyVersion: z.literal("readiness-v2").default("readiness-v2"),
});

export const operationStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_PROVIDER",
  "RECONCILING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);
