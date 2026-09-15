import { useEffect, useState } from "react";
import {
  api,
  type ChartInfo,
  type Environment,
  type HelmAvailability,
  type HelmCompareResponse,
  type LintResult,
  type ResourceCompareResponse,
  type ResourceKind,
} from "./api";
import { exportEverything } from "./excel";
import { useIgnores } from "./ignores";

/**
 * Compare a local Helm chart against a live environment.
 *
 * The chart is rendered with `helm template` and then treated as just another
 * environment, so the comparison tables, filters and Excel export are the same
 * components used everywhere else.
 */
export function HelmView({
  environments,
  renderComparison,
}: {
  environments: Environment[];
  /** Renders the shared per-kind comparison tables. */
  renderComparison: (
    result: HelmCompareResponse,
    drill: {
      expanded: { kind: ResourceKind; canonicalName: string } | null;
      onOpenResource: (kind: ResourceKind, canonicalName: string) => void;
      fieldMatrix: ResourceCompareResponse | null;
      loading: boolean;
      error: string | null;
      activeFilter: string | null;
      onSetFilter: (f: string | null) => void;
    },
  ) => React.ReactNode;
}) {
  const [helm, setHelm] = useState<HelmAvailability | null>(null);

  const [chartPath, setChartPath] = useState("");
  const [chart, setChart] = useState<ChartInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  const [releaseName, setReleaseName] = useState("");
  const [envId, setEnvId] = useState("");
  const [ignoreDefaults, setIgnoreDefaults] = useState(true);

  const [lint, setLint] = useState<LintResult | null>(null);
  const [linting, setLinting] = useState(false);

  const [result, setResult] = useState<HelmCompareResponse | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const [exportingAll, setExportingAll] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const { rules: ignoreRules } = useIgnores();

  const [expanded, setExpanded] = useState<{ kind: ResourceKind; canonicalName: string } | null>(null);
  const [fieldMatrix, setFieldMatrix] = useState<ResourceCompareResponse | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  async function handleOpenResource(kind: ResourceKind, canonicalName: string) {
    if (expanded?.kind === kind && expanded?.canonicalName === canonicalName) {
      setExpanded(null);
      setFieldMatrix(null);
      return;
    }
    if (!chart || !envId) return;
    setExpanded({ kind, canonicalName });
    setFieldMatrix(null);
    setMatrixError(null);
    setActiveFilter(null);
    setMatrixLoading(true);
    try {
      setFieldMatrix(
        await api.helmCompareResource({
          chartPath: chart.path,
          valuesFiles: selectedValues,
          environmentId: envId,
          releaseName: releaseName.trim() || undefined,
          ignoreServerDefaults: ignoreDefaults,
          kind,
          canonicalName,
        }),
      );
    } catch (e) {
      setMatrixError(String(e));
    } finally {
      setMatrixLoading(false);
    }
  }

  useEffect(() => {
    api.helmCheck().then(setHelm).catch((e) => setHelm({ available: false, error: String(e) }));
  }, []);

  async function handleInspect() {
    setInspecting(true);
    setInspectError(null);
    setChart(null);
    setLint(null);
    setResult(null);
    try {
      const info = await api.helmInspect(chartPath);
      setChart(info);
      setReleaseName((prev) => prev || info.name);
      // Default to the base values file if the chart has one.
      const base = info.valuesFiles.find((f) => /^values\.ya?ml$/i.test(f));
      setSelectedValues(base ? [base] : []);
    } catch (e) {
      setInspectError(String(e));
    } finally {
      setInspecting(false);
    }
  }

  function toggleValuesFile(file: string) {
    setSelectedValues((prev) =>
      prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file],
    );
  }

  async function handleLint() {
    if (!chart) return;
    setLinting(true);
    setLint(null);
    try {
      setLint(await api.helmLint(chart.path, selectedValues));
    } catch (e) {
      setLint({ ok: false, messages: [{ severity: "error", text: String(e) }], raw: String(e) });
    } finally {
      setLinting(false);
    }
  }

  async function handleCompare() {
    if (!chart || !envId) return;
    setComparing(true);
    setCompareError(null);
    setResult(null);
    try {
      setResult(
        await api.helmCompare({
          chartPath: chart.path,
          valuesFiles: selectedValues,
          environmentId: envId,
          releaseName: releaseName.trim() || undefined,
          ignoreServerDefaults: ignoreDefaults,
        }),
      );
    } catch (e) {
      setCompareError(String(e));
    } finally {
      setComparing(false);
    }
  }

  /** Re-renders the chart server-side and returns every differing field in one
   *  round-trip, rather than drilling into each resource separately. */
  async function handleExportAll() {
    if (!chart || !envId) return;
    setExportingAll(true);
    setExportError(null);
    try {
      const data = await api.helmCompareExport({
        chartPath: chart.path,
        valuesFiles: selectedValues,
        environmentId: envId,
        releaseName: releaseName.trim() || undefined,
        ignoreServerDefaults: ignoreDefaults,
      });
      await exportEverything({
        envs: data.envs,
        kinds: data.kinds,
        differences: data.differences,
        subject: data.chart.name,
        ignores: ignoreRules,
      });
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExportingAll(false);
    }
  }

  if (helm && !helm.available) {
    return (
      <section className="card">
        <h2>Helm</h2>
        <div className="error">{helm.error}</div>
        <p className="empty">
          This view shells out to the <code>helm</code> CLI to render your chart. Install Helm and
          reload.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h2>Chart</h2>
        <div className="form-row">
          <input
            type="text"
            className="chart-path"
            placeholder="/path/to/your/chart  (the directory containing Chart.yaml)"
            value={chartPath}
            onChange={(e) => setChartPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && chartPath.trim() && handleInspect()}
          />
          <button onClick={handleInspect} disabled={!chartPath.trim() || inspecting}>
            {inspecting ? "Loading…" : "Load chart"}
          </button>
          {helm?.version && <span className="helm-version">helm {helm.version}</span>}
        </div>
        <p className="hint">
          The path is read on the machine running D8s. Nothing is uploaded, and rendering never
          contacts your cluster.
        </p>

        {inspectError && <div className="error">{inspectError}</div>}

        {chart && (
          <div className="chart-info">
            <div className="chart-summary">
              <strong>{chart.name}</strong>
              {chart.version && <span className="chip">chart {chart.version}</span>}
              {chart.appVersion && <span className="chip">app {chart.appVersion}</span>}
              <span className="chart-path-shown">{chart.path}</span>
            </div>
            {chart.description && <p className="hint">{chart.description}</p>}

            <h3>Values files</h3>
            {chart.valuesFiles.length === 0 ? (
              <p className="empty">
                No values files found. The chart's built-in defaults will be used.
              </p>
            ) : (
              <>
                <ul className="values-list">
                  {chart.valuesFiles.map((f) => (
                    <li key={f}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedValues.includes(f)}
                          onChange={() => toggleValuesFile(f)}
                        />
                        <code>{f}</code>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  Files apply in the order listed, later ones overriding earlier — the same as
                  repeating <code>-f</code> on the helm command line. Pick your base values plus
                  the environment-specific file.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      {chart && (
        <section className="card">
          <h2>Lint</h2>
          <div className="form-row">
            <button onClick={handleLint} disabled={linting}>
              {linting ? "Linting…" : "Run helm lint"}
            </button>
            {lint && (
              <span className={lint.ok ? "env-badge ok" : "env-badge error"}>
                {lint.ok ? "Passed" : "Failed"}
              </span>
            )}
          </div>
          {lint && (
            <ul className="lint-list">
              {lint.messages.map((m, i) => (
                <li key={i} className={`lint-${m.severity}`}>
                  {m.severity !== "unknown" && (
                    <span className={`lint-badge lint-badge-${m.severity}`}>{m.severity}</span>
                  )}
                  <span className="lint-text">{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {chart && (
        <section className="card">
          <h2>Compare against environment</h2>
          {environments.length === 0 ? (
            <p className="empty">Add an environment on the Compare tab first.</p>
          ) : (
            <>
              <div className="form-row">
                <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  <option value="">Select environment…</option>
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.label} ({env.namespace})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="release-name"
                  placeholder="Release name"
                  value={releaseName}
                  onChange={(e) => setReleaseName(e.target.value)}
                  aria-label="Helm release name"
                />
                <button onClick={handleCompare} disabled={!envId || comparing}>
                  {comparing ? "Comparing…" : "Compare"}
                </button>
              </div>

              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={ignoreDefaults}
                  onChange={(e) => setIgnoreDefaults(e.target.checked)}
                />
                Ignore fields the cluster fills in automatically
                <span className="hint inline">
                  Hides values Kubernetes defaults when your chart is silent about them, so the
                  diff shows real drift rather than API-server boilerplate. Fields your chart does
                  set are always compared.
                </span>
              </label>
            </>
          )}

          {compareError && <div className="error">{compareError}</div>}
        </section>
      )}

      {result && (
        <div className="export-all helm-export-all">
          <button
            className="export-btn"
            onClick={handleExportAll}
            disabled={exportingAll}
            title="Download one Excel workbook with every chart-vs-cluster difference"
          >
            {exportingAll ? "Building workbook…" : "Export everything to Excel"}
          </button>
          {exportError && <span className="error-inline">{exportError}</span>}
        </div>
      )}

      {result &&
        renderComparison(result, {
          expanded,
          onOpenResource: handleOpenResource,
          fieldMatrix,
          loading: matrixLoading,
          error: matrixError,
          activeFilter,
          onSetFilter: setActiveFilter,
        })}
    </>
  );
}
