import writeXlsxFile from "write-excel-file/browser";
import type { Row } from "write-excel-file/browser";
import type {
  DiffKind,
  FieldMatrixRow,
  ImageVersionRow,
  OverviewRow,
  ResourceDifferences,
} from "./api";

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

const KIND_LABELS: Record<string, string> = {
  deployments: "Deployment",
  statefulSets: "StatefulSet",
  daemonSets: "DaemonSet",
  configMaps: "ConfigMap",
  secrets: "Secret",
  services: "Service",
  pvcs: "PVC",
  ingresses: "Ingress",
  pdbs: "PodDisruptionBudget",
  hpas: "HorizontalPodAutoscaler",
};

/**
 * One workbook covering an entire comparison, with a sheet per section:
 *
 *   Summary          every resource, where it exists, how many fields differ
 *   All differences  every differing field of every resource, kind-tagged
 *   <Kind>           the same rows split per resource kind, for focused review
 *   Image versions   container image tags side by side (when included)
 *
 * The combined sheet is first because Excel's autofilter makes it the most
 * useful view; the per-kind sheets exist so you can hand someone just the
 * ConfigMap drift without them filtering anything.
 */
export async function exportEverything(args: {
  envs: { id: string; label: string }[];
  kinds: Record<string, OverviewRow[]>;
  differences: ResourceDifferences[];
  images?: { rows: ImageVersionRow[] } | null;
  /** Used in the filename, e.g. the chart name for a Helm comparison. */
  subject?: string;
}): Promise<void> {
  const { envs, kinds, differences, images, subject } = args;

  // --- Summary -------------------------------------------------------------
  const summaryHeader: Row = [
    headerCell("Kind"),
    headerCell("Resource"),
    ...envs.map((e) => headerCell(e.label)),
    headerCell("Fields differing"),
  ];
  const summaryRows: Row[] = [];
  for (const [kind, rows] of Object.entries(kinds)) {
    for (const r of rows) {
      summaryRows.push([
        { value: KIND_LABELS[kind] ?? kind, align: "left" as const },
        { value: r.canonicalName, align: "left" as const },
        ...envs.map((e) => ({
          value: r.presentEnvIds.includes(e.id) ? "yes" : "—",
          align: "left" as const,
        })),
        {
          value: r.diffFieldCount === null ? "n/a" : String(r.diffFieldCount),
          align: "left" as const,
          // Flag anything that actually differs so it stands out at a glance.
          backgroundColor: r.diffFieldCount ? KIND_FILL.value : undefined,
        },
      ]);
    }
  }

  // --- Differences ---------------------------------------------------------
  const diffHeader: Row = [
    headerCell("Kind"),
    headerCell("Resource"),
    headerCell("Path"),
    ...envs.map((e) => headerCell(e.label)),
    headerCell("Difference"),
  ];

  const diffRowsFor = (entries: ResourceDifferences[]): Row[] =>
    entries.flatMap(({ kind, resource, rows }) =>
      rows.map((r) => {
        const backgroundColor = KIND_FILL[r.diffKind];
        const cell = (value: string) => ({ value, backgroundColor, align: "left" as const });
        return [
          cell(KIND_LABELS[kind] ?? kind),
          cell(resource),
          cell(r.path),
          ...envs.map((e) => cell(r.cells[e.id]?.present ? displayValue(r.cells[e.id].value) : "")),
          cell(KIND_LABEL[r.diffKind]),
        ];
      }),
    );

  const diffWidths = [
    { width: 22 },
    { width: 30 },
    { width: 58 },
    ...envs.map(() => ({ width: 36 })),
    { width: 28 },
  ];

  const sheets: {
    name: string;
    data: Row[];
    columns: { width: number }[];
  }[] = [
    {
      name: "Summary",
      data: [summaryHeader, ...summaryRows],
      columns: [{ width: 22 }, { width: 34 }, ...envs.map(() => ({ width: 16 })), { width: 18 }],
    },
    {
      name: "All differences",
      data: [diffHeader, ...diffRowsFor(differences)],
      columns: diffWidths,
    },
  ];

  // Per-kind sheets, only for kinds that actually have differences.
  for (const kind of Object.keys(KIND_LABELS)) {
    const entries = differences.filter((d) => d.kind === kind);
    if (entries.length === 0) continue;
    sheets.push({
      // Excel sheet names cap at 31 chars and forbid a handful of characters.
      name: sheetName(`${KIND_LABELS[kind] ?? kind}s`),
      data: [diffHeader, ...diffRowsFor(entries)],
      columns: diffWidths,
    });
  }

  if (images && images.rows.length > 0) {
    const header: Row = [
      headerCell("Deployment"),
      headerCell("Container"),
      ...envs.map((e) => headerCell(e.label)),
      headerCell("Versions differ"),
    ];
    const rows: Row[] = images.rows.map((r) => {
      const backgroundColor = r.differs ? KIND_FILL.value : undefined;
      const cell = (value: string) => ({ value, backgroundColor, align: "left" as const });
      return [
        cell(r.deployment),
        cell(r.container + (r.isInit ? " (init)" : "")),
        ...envs.map((e) => cell(r.images[e.id] ?? "")),
        cell(r.differs ? "yes" : "no"),
      ];
    });
    sheets.push({
      name: "Image versions",
      data: [header, ...rows],
      columns: [{ width: 32 }, { width: 32 }, ...envs.map(() => ({ width: 44 })), { width: 16 }],
    });
  }

  await writeXlsxFile(
    sheets.map((s) => ({
      data: s.data,
      sheet: s.name,
      columns: s.columns,
      stickyRowsCount: 1,
    })),
  ).toFile(`d8s-${subject ? slug(subject) + "-" : ""}comparison-${timestamp()}.xlsx`);
}

/** Excel rejects > 31 chars and the characters : \ / ? * [ ] in sheet names. */
function sheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
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
