import { describe, expect, it } from "vitest";

import {
  clearPortalRecoveryForUser,
  loadRecovery,
  recoveryKey,
  saveRecovery,
} from "@/features/portal/editor/editor-recovery";
import type { PortalSceneV1 } from "@/features/portal/portal-scene";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  keys() { return [...this.values.keys()]; }
}

class ThrowingStorage {
  getItem(): string | null { throw new Error("blocked get"); }
  setItem(): void { throw new Error("blocked set"); }
  removeItem(): void { throw new Error("blocked remove"); }
  keys(): string[] { throw new Error("blocked keys"); }
}

const state: PortalSceneV1 = {
  sceneVersion: 1,
  viewport: "DESKTOP",
  requiresMobileReview: false,
  background: {
    assetId: null,
    fitMode: "COVER",
    positionX: 50,
    positionY: 50,
    backgroundColor: "#FFFFFF",
    locked: false,
  },
  elements: [],
};

describe("portal editor recovery", () => {
  it("does not restore another user or expired privileged draft", () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-07-25T10:00:00.000Z");

    saveRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", state, now);
    expect(loadRecovery(storage, "admin-b", "SHANGHAI", "DESKTOP", now)).toBeNull();
    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", new Date(now.getTime() + 25 * 60 * 60 * 1000))).toBeNull();
    expect(storage.getItem(recoveryKey("admin-a", "SHANGHAI", "DESKTOP"))).toBeNull();
  });

  it("uses a user/city/viewport key and rejects malformed strict scenes", () => {
    const storage = new MemoryStorage();
    const key = recoveryKey("admin-a", "SHANGHAI", "DESKTOP");
    expect(key).toBe("portal-editor:admin-a:SHANGHAI:DESKTOP");
    storage.setItem(key, JSON.stringify({ savedAt: "2026-07-25T10:00:00.000Z", scene: { ...state, extra: true } }));

    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", new Date("2026-07-25T11:00:00.000Z"))).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("removes an empty recovery value because it is not a strict envelope", () => {
    const storage = new MemoryStorage();
    const key = recoveryKey("admin-a", "SHANGHAI", "DESKTOP");
    storage.setItem(key, "");

    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", new Date("2026-07-25T11:00:00.000Z"))).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("uses encoded, collision-free key parts and clears an exact user scope only", () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-07-25T10:00:00.000Z");
    const first = recoveryKey("u", "a:b", "DESKTOP");
    const second = recoveryKey("u:a", "b", "DESKTOP");
    expect(first).not.toBe(second);

    saveRecovery(storage, "u", "a:b", "DESKTOP", state, now);
    saveRecovery(storage, "u:a", "b", "DESKTOP", state, now);
    clearPortalRecoveryForUser(storage, "u");

    expect(storage.getItem(first)).toBeNull();
    expect(storage.getItem(second)).not.toBeNull();
  });

  it("expires at exactly 24 hours and rejects a non-finite clock", () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-07-25T10:00:00.000Z");
    const key = recoveryKey("admin-a", "SHANGHAI", "DESKTOP");
    saveRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", state, now);

    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", new Date(now.getTime() + 24 * 60 * 60 * 1000))).toBeNull();
    expect(storage.getItem(key)).toBeNull();

    saveRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", state, now);
    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", new Date("invalid"))).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("treats optional storage get, set, remove, and key iteration failures as best-effort", () => {
    const storage = new ThrowingStorage();
    const now = new Date("2026-07-25T10:00:00.000Z");

    expect(() => saveRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", state, now)).not.toThrow();
    expect(() => loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", now)).not.toThrow();
    expect(loadRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", now)).toBeNull();
    expect(() => clearPortalRecoveryForUser(storage, "admin-a")).not.toThrow();
  });

  it("clears every recovery entry belonging to one user only", () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-07-25T10:00:00.000Z");
    saveRecovery(storage, "admin-a", "SHANGHAI", "DESKTOP", state, now);
    saveRecovery(storage, "admin-a", "SHENZHEN", "MOBILE", { ...state, viewport: "MOBILE" }, now);
    saveRecovery(storage, "admin-b", "SHANGHAI", "DESKTOP", state, now);

    clearPortalRecoveryForUser(storage, "admin-a");

    expect(storage.keys()).toEqual([recoveryKey("admin-b", "SHANGHAI", "DESKTOP")]);
  });
});
