import { t } from "../i18n";
import type { ChannelResult } from "./types";

export type ExportScope = "all" | "filtered" | "selected";

/** Several selected rows are a deliberate pick; a single one is just the
 *  row in focus, so it does not narrow an export. */
export function defaultExportScope(selectedRows: number): ExportScope {
  return selectedRows > 1 ? "selected" : "all";
}

export function exportScopeLabel(scope: ExportScope): string {
  return t(`exportMenu.scope.${scope}`);
}

export function exportScopeFileSuffix(scope: ExportScope): string {
  switch (scope) {
    case "all":
      return "all";
    case "filtered":
      return "filtered";
    case "selected":
      return "selected";
  }
}

export function resolveExportScopeResults(
  scope: ExportScope,
  allResults: ChannelResult[],
  filteredResults: ChannelResult[],
  selectedResults: ChannelResult[],
): ChannelResult[] {
  switch (scope) {
    case "all":
      return allResults;
    case "filtered":
      return filteredResults;
    case "selected":
      return selectedResults;
  }
}
