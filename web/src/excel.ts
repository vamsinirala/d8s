import writeXlsxFile from "write-excel-file/browser";
import type { Row } from "write-excel-file/browser";
import type { DiffKind, FieldMatrixRow, ImageVersionRow } from "./api";

/**
 * Excel export for the diff views.
 *
 * The point of using xlsx rather than CSV is that the row colouring carries
 * meaning here — amber for "value differs", blue for "missing in some
 * environments" — and that survives into the spreadsheet, along with a frozen,
 * bold header row and sensible column widths.
 */

const HEADER_BG = "#EEF0F4";

/** Row fills mirroring the in-app legend. Slightly stronger than the on-screen
 *  tints, which are too faint to read once Excel renders its own gridlines. */
const KIND_FILL: Record<DiffKind, string | undefined> = {
  identical: undefined,
  value: "#FFF3DC",
  presence: "#E8EFFB",
};

const KIND_LABEL: Record<DiffKind, string> = {
  identical: "Identical",
  value: "Value differs",
  presence: "Missing in some environments",
};

function headerCell(value: string) {
  return {
    value,
    fontWeight: "bold" as const,
    backgroundColor: HEADER_BG,
    align: "left" as const,
    borderColor: "#D0D5DD",
    borderStyle: "thin" as const,
  };
}

/** Values are strings, numbers or booleans in a sheet; anything else is JSON. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "export";
}

/**
 * Field-level diff for a single resource.
 * `rows` is whatever the view currently shows, so the export respects the
 * active difference-kind, category and search filters.
 */
export async function exportFieldDiff(
  rows: FieldMatrixRow[],
  envs: { id: string; label: string }[],
  kind: string,
  resourceName: string,
): Promise<void> {
  const header: Row = [
    headerCell("Path"),
    ...envs.map((e) => headerCell(e.label)),
    headerCell("Difference"),
  ];

  const body: Row[] = rows.map((r) => {
    const backgroundColor = KIND_FILL[r.diffKind];
    const cell = (value: string) => ({ value, backgroundColor, align: "left" as const });
    return [
      cell(r.path),
      // A field absent from an environment exports as an empty cell; the
      // Difference column still records that the row is a presence difference.
      ...envs.map((e) => cell(r.cells[e.id]?.present ? displayValue(r.cells[e.id].value) : "")),
      cell(KIND_LABEL[r.diffKind]),
    ];
  });

  // The browser build returns a handle; toFile() triggers the download.
  await writeXlsxFile([header, ...body], {
    columns: [{ width: 62 }, ...envs.map(() => ({ width: 38 })), { width: 28 }],
    stickyRowsCount: 1,
    sheet: "Field diff",
  }).toFile(`d8s-${slug(kind)}-${slug(resourceName)}-diff-${timestamp()}.xlsx`);
}

/**
 * Image versions across environments.
 * `rows` is whatever the view currently shows, so the export respects the
 * active drift filter and search.
 */
export async function exportImageVersions(
  rows: ImageVersionRow[],
  envs: { id: string; label: string }[],
): Promise<void> {
  const header: Row = [
    headerCell("Deployment"),
    headerCell("Container"),
    headerCell("Init container"),
    ...envs.map((e) => headerCell(e.label)),
    headerCell("Versions differ"),
  ];

  const body: Row[] = rows.map((r) => {
    const backgroundColor = r.differs ? KIND_FILL.value : undefined;
    const cell = (value: string) => ({ value, backgroundColor, align: "left" as const });
    return [
      cell(r.deployment),
      cell(r.container),
      cell(r.isInit ? "yes" : "no"),
      // A deployment absent from an environment exports as an empty cell.
      ...envs.map((e) => cell(r.images[e.id] ?? "")),
      cell(r.differs ? "yes" : "no"),
    ];
  });

  await writeXlsxFile([header, ...body], {
    columns: [{ width: 34 }, { width: 34 }, { width: 14 }, ...envs.map(() => ({ width: 44 })), { width: 16 }],
    stickyRowsCount: 1,
    sheet: "Image versions",
  }).toFile(`d8s-image-versions-${timestamp()}.xlsx`);
}
