import type { MessageKey } from "../i18n";
import type { SortField } from "./filters";

export type ColumnKey = SortField;
export const COLUMN_ORDER_STORAGE_KEY = "iptv-checker.column-order.v1";
export const COLUMN_WIDTH_STORAGE_KEY = "iptv-checker.column-widths.v1";

export interface ColumnDefinition {
  key: ColumnKey;
  labelKey: Extract<MessageKey, `table.columns.${string}`>;
  defaultWidth: number;
  minWidth: number;
  align?: "left" | "center" | "right";
}

export const COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { key: "index", labelKey: "table.columns.index", defaultWidth: 58, minWidth: 46, align: "left" },
  {
    key: "status",
    labelKey: "table.columns.status",
    defaultWidth: 40,
    minWidth: 32,
    align: "left",
  },
  {
    key: "error",
    labelKey: "table.columns.error",
    defaultWidth: 240,
    minWidth: 140,
    align: "left",
  },
  {
    key: "playlist",
    labelKey: "table.columns.playlist",
    defaultWidth: 190,
    minWidth: 130,
    align: "left",
  },
  { key: "name", labelKey: "table.columns.name", defaultWidth: 360, minWidth: 180, align: "left" },
  { key: "url", labelKey: "table.columns.url", defaultWidth: 320, minWidth: 180, align: "left" },
  {
    key: "group",
    labelKey: "table.columns.group",
    defaultWidth: 220,
    minWidth: 120,
    align: "left",
  },
  {
    key: "resolution",
    labelKey: "table.columns.resolution",
    defaultWidth: 84,
    minWidth: 68,
    align: "center",
  },
  {
    key: "codec",
    labelKey: "table.columns.codec",
    defaultWidth: 66,
    minWidth: 50,
    align: "center",
  },
  { key: "fps", labelKey: "table.columns.fps", defaultWidth: 48, minWidth: 40, align: "center" },
  {
    key: "bitrate",
    labelKey: "table.columns.bitrate",
    defaultWidth: 100,
    minWidth: 80,
    align: "right",
  },
  { key: "hdr", labelKey: "table.columns.hdr", defaultWidth: 90, minWidth: 70, align: "center" },
  {
    key: "latency",
    labelKey: "table.columns.latency",
    defaultWidth: 76,
    minWidth: 62,
    align: "right",
  },
  { key: "audio", labelKey: "table.columns.audio", defaultWidth: 84, minWidth: 66, align: "right" },
  {
    key: "audio_codec",
    labelKey: "table.columns.audioCodec",
    defaultWidth: 72,
    minWidth: 56,
    align: "center",
  },
  {
    key: "audio_layout",
    labelKey: "table.columns.audioLayout",
    defaultWidth: 92,
    minWidth: 72,
    align: "center",
  },
  {
    key: "catchup",
    labelKey: "table.columns.catchup",
    defaultWidth: 92,
    minWidth: 72,
    align: "center",
  },
];

export const COLUMN_DEFINITION_MAP: Record<ColumnKey, ColumnDefinition> = COLUMN_DEFINITIONS.reduce(
  (acc, column) => {
    acc[column.key] = column;
    return acc;
  },
  {} as Record<ColumnKey, ColumnDefinition>,
);

export const DEFAULT_COLUMN_ORDER: ColumnKey[] = COLUMN_DEFINITIONS.map((column) => column.key);

export const DEFAULT_VISIBLE_COLUMN_ORDER: ColumnKey[] = DEFAULT_COLUMN_ORDER.filter(
  (key) => key !== "url" && key !== "error" && key !== "playlist" && key !== "audio_layout",
);

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = COLUMN_DEFINITIONS.reduce(
  (acc, column) => {
    acc[column.key] = column.defaultWidth;
    return acc;
  },
  {} as Record<ColumnKey, number>,
);

export function parseStoredColumnOrder(
  raw: string | null,
  fallbackOrder: ColumnKey[],
): ColumnKey[] {
  if (!raw) return fallbackOrder;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallbackOrder;

    const known = new Set(DEFAULT_COLUMN_ORDER);
    const deduped: ColumnKey[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      if (!known.has(item as ColumnKey)) continue;
      if (deduped.includes(item as ColumnKey)) continue;
      deduped.push(item as ColumnKey);
    }

    if (deduped.length === 0) {
      return fallbackOrder;
    }

    for (const key of fallbackOrder) {
      if (!deduped.includes(key)) deduped.push(key);
    }
    return deduped;
  } catch {
    return fallbackOrder;
  }
}

export function readStoredVisibleColumnOrder(): ColumnKey[] {
  return parseStoredColumnOrder(
    localStorage.getItem(COLUMN_ORDER_STORAGE_KEY),
    DEFAULT_VISIBLE_COLUMN_ORDER,
  );
}

export function parseStoredColumnWidths(raw: string | null): Record<ColumnKey, number> {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  if (!raw) return widths;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return widths;

    for (const key of DEFAULT_COLUMN_ORDER) {
      const maybeWidth = parsed[key];
      const minWidth = COLUMN_DEFINITION_MAP[key].minWidth;
      if (typeof maybeWidth === "number" && Number.isFinite(maybeWidth)) {
        widths[key] = Math.max(minWidth, Math.round(maybeWidth));
      }
    }
  } catch {
    // Ignore malformed persisted values.
  }

  return widths;
}
