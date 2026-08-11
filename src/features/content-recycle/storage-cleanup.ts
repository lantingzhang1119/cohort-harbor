import { unlink } from "node:fs/promises";

import { resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

export async function unlinkPrivateStorageKeys(storageKeys: string[], privateRoot: string) {
  const unique = [...new Set(storageKeys.filter(Boolean))];
  await Promise.all(unique.map(async (storageKey) => {
    const absolute = await resolvePrivateAssetPathSecure(storageKey, privateRoot);
    if (absolute) await unlink(absolute).catch(() => undefined);
  }));
}
