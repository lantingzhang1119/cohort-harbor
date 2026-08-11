import path from "node:path";
import { realpath } from "node:fs/promises";

export const defaultPrivateRoot = path.resolve(/* turbopackIgnore: true */ process.env.PRIVATE_STORAGE_ROOT ?? "storage/private");

export function resolvePrivateAssetPath(
  storageKey: string,
  privateRoot = defaultPrivateRoot,
): string | null {
  if (!storageKey || path.isAbsolute(storageKey)) return null;
  const root = path.resolve(/* turbopackIgnore: true */ privateRoot);
  const resolved = path.resolve(/* turbopackIgnore: true */ root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export async function resolvePrivateAssetPathSecure(
  storageKey: string,
  privateRoot = defaultPrivateRoot,
  options: { allowMissingLeaf?: boolean } = {},
): Promise<string | null> {
  const lexical = resolvePrivateAssetPath(storageKey, privateRoot);
  if (!lexical) return null;
  try {
    const realRoot = await realpath(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ privateRoot));
    const candidate = options.allowMissingLeaf
      ? path.join(/* turbopackIgnore: true */ await realpath(/* turbopackIgnore: true */ path.dirname(lexical)), path.basename(lexical))
      : await realpath(/* turbopackIgnore: true */ lexical);
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) return null;
    return candidate;
  } catch {
    return null;
  }
}
