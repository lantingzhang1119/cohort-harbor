import type { WorkLocation } from "@/generated/prisma/enums";
import type { AssigneeSelectionInput } from "@/features/exam-tasks/schemas";

export type WizardEmployeeFilter = {
  query: string;
  department: string;
  location: string;
  enabled: string;
};

export type WizardSelectionState =
  | { mode: "EXPLICIT"; selectedIds: string[] }
  | { mode: "FILTER"; filter: WizardEmployeeFilter; excludedIds: string[] };

export function emptyWizardFilter(): WizardEmployeeFilter {
  return { query: "", department: "", location: "", enabled: "" };
}

export function emptyExplicitSelection(): WizardSelectionState {
  return { mode: "EXPLICIT", selectedIds: [] };
}

export function toApiSelection(state: WizardSelectionState): AssigneeSelectionInput | null {
  if (state.mode === "EXPLICIT") {
    if (!state.selectedIds.length) return null;
    return { mode: "EXPLICIT", userIds: [...state.selectedIds] };
  }
  return {
    mode: "FILTER",
    filter: {
      ...(state.filter.query ? { query: state.filter.query } : {}),
      ...(state.filter.department ? { department: state.filter.department } : {}),
      ...(state.filter.location
        ? { location: state.filter.location as WorkLocation }
        : {}),
      ...(state.filter.enabled === "true"
        ? { enabled: true }
        : state.filter.enabled === "false"
          ? { enabled: false }
          : {}),
    },
    excludedUserIds: [...state.excludedIds],
  };
}

export function isSelected(state: WizardSelectionState, userId: string): boolean {
  if (state.mode === "EXPLICIT") {
    return state.selectedIds.includes(userId);
  }
  return !state.excludedIds.includes(userId);
}

export function toggleUser(
  state: WizardSelectionState,
  userId: string,
  pageUserIds: string[],
): WizardSelectionState {
  if (state.mode === "EXPLICIT") {
    const selected = new Set(state.selectedIds);
    if (selected.has(userId)) selected.delete(userId);
    else selected.add(userId);
    return { mode: "EXPLICIT", selectedIds: [...selected] };
  }

  // FILTER mode: all matched are selected except excluded.
  // Toggling a user not on current page is still exclusion-based.
  void pageUserIds;
  const excluded = new Set(state.excludedIds);
  if (excluded.has(userId)) {
    excluded.delete(userId);
  } else {
    excluded.add(userId);
  }
  return { mode: "FILTER", filter: state.filter, excludedIds: [...excluded] };
}

export function selectCurrentPage(
  state: WizardSelectionState,
  pageUserIds: string[],
): WizardSelectionState {
  if (state.mode === "EXPLICIT") {
    const selected = new Set(state.selectedIds);
    for (const id of pageUserIds) selected.add(id);
    return { mode: "EXPLICIT", selectedIds: [...selected] };
  }
  const excluded = new Set(state.excludedIds);
  for (const id of pageUserIds) excluded.delete(id);
  return { mode: "FILTER", filter: state.filter, excludedIds: [...excluded] };
}

export function clearCurrentPage(
  state: WizardSelectionState,
  pageUserIds: string[],
): WizardSelectionState {
  if (state.mode === "EXPLICIT") {
    const page = new Set(pageUserIds);
    return {
      mode: "EXPLICIT",
      selectedIds: state.selectedIds.filter((id) => !page.has(id)),
    };
  }
  const excluded = new Set(state.excludedIds);
  for (const id of pageUserIds) excluded.add(id);
  return { mode: "FILTER", filter: state.filter, excludedIds: [...excluded] };
}

export function selectAllFiltered(
  filter: WizardEmployeeFilter,
): WizardSelectionState {
  return { mode: "FILTER", filter: { ...filter }, excludedIds: [] };
}

export function removeSelectedUser(
  state: WizardSelectionState,
  userId: string,
): WizardSelectionState {
  if (state.mode === "EXPLICIT") {
    return {
      mode: "EXPLICIT",
      selectedIds: state.selectedIds.filter((id) => id !== userId),
    };
  }
  if (state.excludedIds.includes(userId)) return state;
  return {
    mode: "FILTER",
    filter: state.filter,
    excludedIds: [...state.excludedIds, userId],
  };
}

export function pageSelectionSummary(
  state: WizardSelectionState,
  pageUserIds: string[],
): { selectedOnPage: number; allOnPageSelected: boolean } {
  const selectedOnPage = pageUserIds.filter((id) => isSelected(state, id)).length;
  return {
    selectedOnPage,
    allOnPageSelected: pageUserIds.length > 0 && selectedOnPage === pageUserIds.length,
  };
}
