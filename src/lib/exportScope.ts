import { t } from "../i18n";
import type { ChannelResult } from "./types";

export type ExportScope = "all" | "filtered" | "selected";

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
