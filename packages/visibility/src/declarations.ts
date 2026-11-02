import { z } from "zod";
import { normalizeUrl } from "./url";
import type { ReadinessDeclarations } from "./types";

/** Passive identity only. This parser never admits a network destination. */
export function passiveUrl(value: string, base?: string): string | null {
  if (
    !value.trim() ||
    /[\\\u0000-\u0020\u007f]/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value) ||
    (/^https?:/i.test(value) && !/^https?:\/\/[^/?#]/i.test(value)) ||
    value.length > 2048 ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    return null;
  try {
    const url = new URL(value, base);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.hash = "";
    url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, (s) => {
      const char = String.fromCharCode(parseInt(s.slice(1), 16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : s.toUpperCase();
    });
    return url.href;
  } catch {
    return null;
  }
}

const target = z
  .string()
  .max(2048)
  .refine((s) => /^https?:\/\//i.test(s) && passiveUrl(s) !== null);
const text = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((s) => !/[\u0000\uD800-\uDFFF]/u.test(s));
export const declarationsSchema = z.strictObject({
  brandName: text.optional(),
  approvedAliases: z.array(text).max(20).optional(),
  officialUrls: z.array(target).max(20).optional(),
  aboutUrl: target.optional(),
  contactUrl: target.optional(),
  requiredPolicyUrls: z.array(target).max(20).optional(),
  pageDeclarations: z
    .array(
      z.strictObject({
        requestedUrl: target,
        indexingIntent: z.enum(["indexable", "excluded"]).optional(),
        pageType: z
          .enum(["marketing", "article", "product", "other"])
          .optional(),
        intendedCanonical: target.optional(),
      }),
    )
    .max(25)
    .optional(),
});
export function validateDeclarations(
  input: unknown,
  manifest: string[],
  origin: string,
): ReadinessDeclarations {
  const parsed = declarationsSchema.safeParse(input);
  if (!parsed.success || JSON.stringify(parsed.data).length > 16384)
    throw new Error("INVALID_AUDIT_INPUT");
  const data = parsed.data;
  const urls = [
    data.aboutUrl,
    data.contactUrl,
    ...(data.requiredPolicyUrls ?? []),
  ].filter((url): url is string => !!url);
  if (urls.some((url) => new URL(url).origin !== origin))
    throw new Error("INVALID_AUDIT_INPUT");
  const seen = new Set<string>();
  for (const declaration of data.pageDeclarations ?? []) {
    try {
      declaration.requestedUrl = normalizeUrl(declaration.requestedUrl);
    } catch {
      throw new Error("INVALID_AUDIT_INPUT");
    }
    if (
      !manifest.includes(declaration.requestedUrl) ||
      seen.has(declaration.requestedUrl)
    )
      throw new Error("INVALID_AUDIT_INPUT");
    seen.add(declaration.requestedUrl);
  }
  return data;
}
