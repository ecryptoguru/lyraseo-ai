// Prisma wraps PostgreSQL RAISE EXCEPTION as P2010. Keep the audit domain
// codes that existing HTTP routes match exactly; never expose driver messages.
export function auditErrorCode(error: unknown): string | undefined {
  const e = error as {
    code?: string;
    meta?: {
      driverAdapterError?: {
        cause?: { originalCode?: string; originalMessage?: string };
      };
    };
  } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  const value =
    e?.code === "P2010" && cause?.originalCode === "P0001"
      ? cause.originalMessage
      : error instanceof Error
        ? error.message
        : undefined;
  return value && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}
