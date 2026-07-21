export function validateAdapterDiscovery(value) {
  for (const key of [
    "productSlug",
    "sourceRoot",
    "sourcePath",
    "name",
    "bank",
    "subBank",
    "author",
    "sourceFingerprint"
  ]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`invalid discovery field ${key}`);
    }
  }
  if (!Array.isArray(value.types) || !Array.isArray(value.modes)) {
    throw new Error("types and modes must be arrays");
  }
  return Object.freeze(value);
}
