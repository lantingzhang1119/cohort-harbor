import { z } from "zod";

import { portalSceneV1Schema, type PortalSceneV1, type PortalViewportInput } from "@/features/portal/portal-scene";

export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  key?: (index: number) => string | null;
  length?: number;
  keys?: () => string[];
};

const RECOVERY_PREFIX = "portal-editor:";
const RECOVERY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const recoveryEnvelopeSchema = z.object({
  savedAt: z.string().datetime(),
  scene: portalSceneV1Schema,
}).strict();

function isRecoveryStorage(value: unknown): value is RecoveryStorage {
  return typeof value === "object" && value !== null
    && "getItem" in value && typeof value.getItem === "function"
    && "setItem" in value && typeof value.setItem === "function"
    && "removeItem" in value && typeof value.removeItem === "function";
}

export function portalRecoveryStorage(): RecoveryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function recoveryKeys(storage: RecoveryStorage) {
  try {
    if (storage.keys) return storage.keys();
    if (typeof storage.length !== "number" || !storage.key) return [];
    return Array.from({ length: storage.length }, (_, index) => storage.key!(index)).filter((key): key is string => key !== null);
  } catch {
    return [];
  }
}

function getItem(storage: RecoveryStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(storage: RecoveryStorage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    // Recovery is optional and must not break editing when browser storage is unavailable.
  }
}

function removeItem(storage: RecoveryStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // A failed cleanup must not make recovery loading throw.
  }
}

export function recoveryKey(userId: string, city: string, viewport: PortalViewportInput) {
  return `${RECOVERY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(city)}:${encodeURIComponent(viewport)}`;
}

export function saveRecovery(
  storage: RecoveryStorage,
  userId: string,
  city: string,
  viewport: PortalViewportInput,
  scene: PortalSceneV1,
  now: Date = new Date(),
) {
  const strictScene = portalSceneV1Schema.safeParse(scene);
  if (!strictScene.success || !Number.isFinite(now.getTime())) return;
  if (strictScene.data.viewport !== viewport) return;
  setItem(storage, recoveryKey(userId, city, viewport), JSON.stringify({ savedAt: now.toISOString(), scene: strictScene.data }));
}

export function loadRecovery(
  storage: RecoveryStorage,
  userId: string,
  city: string,
  viewport: PortalViewportInput,
  now: Date = new Date(),
): PortalSceneV1 | null {
  const key = recoveryKey(userId, city, viewport);
  const raw = getItem(storage, key);
  if (raw === null) return null;

  try {
    const parsed = recoveryEnvelopeSchema.parse(JSON.parse(raw));
    const savedAt = new Date(parsed.savedAt);
    const age = now.getTime() - savedAt.getTime();
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(savedAt.getTime()) || age < 0 || age >= RECOVERY_LIFETIME_MS || parsed.scene.viewport !== viewport) {
      removeItem(storage, key);
      return null;
    }
    return parsed.scene as PortalSceneV1;
  } catch {
    removeItem(storage, key);
    return null;
  }
}

export function clearPortalRecoveryForUser(storage: RecoveryStorage, userId: string): void;
export function clearPortalRecoveryForUser(userId: string, storage?: RecoveryStorage): void;
export function clearPortalRecoveryForUser(
  storageOrUserId: RecoveryStorage | string,
  possibleUserIdOrStorage?: string | RecoveryStorage,
) {
  const storage = isRecoveryStorage(storageOrUserId)
    ? storageOrUserId
    : isRecoveryStorage(possibleUserIdOrStorage) ? possibleUserIdOrStorage : portalRecoveryStorage();
  const userId = typeof storageOrUserId === "string" ? storageOrUserId : possibleUserIdOrStorage;
  if (!storage || typeof userId !== "string") return;

  const prefix = `${RECOVERY_PREFIX}${encodeURIComponent(userId)}:`;
  for (const key of recoveryKeys(storage)) {
    if (key.startsWith(prefix)) removeItem(storage, key);
  }
}

export function clearAllPortalRecovery(storage: RecoveryStorage | null = portalRecoveryStorage()) {
  if (!storage) return;
  for (const key of recoveryKeys(storage)) {
    if (key.startsWith(RECOVERY_PREFIX)) removeItem(storage, key);
  }
}

export function clearPortalRecoveryAfterLogout() {
  clearAllPortalRecovery();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("portal-recovery-clear"));
  }
}
