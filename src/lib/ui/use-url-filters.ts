"use client";

import { useCallback, useEffect, useState } from "react";

type StringFilters = Record<string, string>;

export function useUrlFilters<T extends StringFilters>(
  initialFilters: T,
  keys: readonly (keyof T)[],
  readFilters: (params: URLSearchParams) => T,
) {
  const [filters, setFilters] = useState<T>(() =>
    typeof window === "undefined"
      ? initialFilters
      : window.location.search
        ? readFilters(new URLSearchParams(window.location.search))
        : initialFilters);

  useEffect(() => {
    const synchronizeFromHistory = () => {
      setFilters(readFilters(new URLSearchParams(window.location.search)));
    };
    window.addEventListener("popstate", synchronizeFromHistory);
    return () => window.removeEventListener("popstate", synchronizeFromHistory);
  }, [readFilters]);

  const updateFilters = useCallback((patch: Partial<T>) => {
    const next = { ...filters, ...patch };
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) {
      const value = next[key];
      if (value) params.set(String(key), value);
      else params.delete(String(key));
    }
    const query = params.toString();
    window.history.pushState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    setFilters(next);
  }, [filters, keys]);

  return [filters, updateFilters] as const;
}
