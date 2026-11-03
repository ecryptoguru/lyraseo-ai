// Node 24 strips TypeScript types but does not resolve the repository's
// extensionless TypeScript imports. This local CLI loader adds only .ts fallback.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      !specifier.startsWith(".") ||
      /\.[a-z]+$/i.test(specifier) ||
      error?.code !== "ERR_MODULE_NOT_FOUND"
    )
      throw error;
    return nextResolve(specifier + ".ts", context);
  }
}
