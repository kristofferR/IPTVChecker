import type { SortField } from "./filters";

export type ColumnKey = SortField;
export const COLUMN_ORDER_STORAGE_KEY = "iptv-checker.column-order.v1";
export const COLUMN_WIDTH_STORAGE_KEY = "iptv-checker.column-widths.v1";

export interface ColumnDefinition {
  key: ColumnKey;
  label: string;
  defaultWidth: number;
  minWidth: number;
  align?: "left" | "center" | "right";
}

export const COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { key: "index", label: "#", defaultWidth: 64, minWidth: 52, align: "left" },
  { key: "status", label: "St", defaultWidth: 56, minWidth: 48, align: "left" },
  { key: "error", label: "Error", defaultWidth: 240, minWidth: 140, align: "left" },
  { key: "playlist", label: "Playlist", defaultWidth: 190, minWidth: 130, align: "left" },
  { key: "name", label: "Channel Name", defaultWidth: 360, minWidth: 180, align: "left" },
  { key: "url", label: "URL", defaultWidth: 320, minWidth: 180, align: "left" },
  { key: "group", label: "Group", defaultWidth: 220, minWidth: 120, align: "left" },
  { key: "resolution", label: "Res", defaultWidth: 96, minWidth: 72, align: "center" },
  { key: "codec", label: "Codec", defaultWidth: 96, minWidth: 72, align: "center" },
  { key: "fps", label: "FPS", defaultWidth: 84, minWidth: 68, align: "center" },
  { key: "latency", label: "Latency", defaultWidth: 102, minWidth: 84, align: "right" },
  { key: "bitrate", label: "Bitrate", defaultWidth: 124, minWidth: 90, align: "right" },
  { key: "audio", label: "Audio", defaultWidth: 126, minWidth: 90, align: "right" },
];

export const COLUMN_DEFINITION_MAP: Record<ColumnKey, ColumnDefinition> =
  COLUMN_DEFINITIONS.reduce(
    (acc, column) => {
      acc[column.key] = column;
      return acc;
    },
    {} as Record<ColumnKey, ColumnDefinition>,
  );

export const DEFAULT_COLUMN_ORDER: ColumnKey[] = COLUMN_DEFINITIONS.map(
  (column) => column.key,
);

export const DEFAULT_VISIBLE_COLUMN_ORDER: ColumnKey[] = DEFAULT_COLUMN_ORDER.filter(
  (key) => key !== "url" && key !== "latency" && key !== "error",
);

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> =
  COLUMN_DEFINITIONS.reduce(
    (acc, column) => {
      acc[column.key] = column.defaultWidth;
      return acc;
    },
    {} as Record<ColumnKey, number>,
  );
