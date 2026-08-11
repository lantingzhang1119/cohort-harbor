import { describe, expect, it } from "vitest";

import {
  clearCurrentPage,
  emptyExplicitSelection,
  isSelected,
  pageSelectionSummary,
  selectAllFiltered,
  selectCurrentPage,
  toApiSelection,
  toggleUser,
} from "@/features/exam-tasks/selection-state";

describe("exam task selection state semantics", () => {
  it("keeps explicit selections across pages", () => {
    let state = emptyExplicitSelection();
    state = selectCurrentPage(state, ["e1", "e2"]);
    state = toggleUser(state, "e3", ["e3", "e4"]);
    expect(toApiSelection(state)).toEqual({
      mode: "EXPLICIT",
      userIds: ["e1", "e2", "e3"],
    });
    expect(isSelected(state, "e1")).toBe(true);
    expect(isSelected(state, "e4")).toBe(false);
  });

  it("models select-all-filtered with exclusions", () => {
    let state = selectAllFiltered({
      query: "张",
      department: "研发中心",
      location: "SHANGHAI",
      enabled: "true",
    });
    state = toggleUser(state, "skip-me", ["skip-me", "keep-me"]);
    expect(toApiSelection(state)).toEqual({
      mode: "FILTER",
      filter: {
        query: "张",
        department: "研发中心",
        location: "SHANGHAI",
        enabled: true,
      },
      excludedUserIds: ["skip-me"],
    });
    expect(isSelected(state, "keep-me")).toBe(true);
    expect(isSelected(state, "skip-me")).toBe(false);
  });

  it("supports select/clear current page in both modes", () => {
    let explicit = selectCurrentPage(emptyExplicitSelection(), ["a", "b"]);
    explicit = clearCurrentPage(explicit, ["a"]);
    expect(pageSelectionSummary(explicit, ["a", "b"])).toEqual({
      selectedOnPage: 1,
      allOnPageSelected: false,
    });

    let filtered = selectAllFiltered({
      query: "",
      department: "",
      location: "",
      enabled: "",
    });
    filtered = clearCurrentPage(filtered, ["x"]);
    filtered = selectCurrentPage(filtered, ["x"]);
    expect(isSelected(filtered, "x")).toBe(true);
    expect(toApiSelection(filtered)?.mode).toBe("FILTER");
  });
});
