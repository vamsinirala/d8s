import { Fragment, useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import YAML from "yaml";
import {
  api,
  RESOURCE_KINDS,
  type ContextInfo,
  type DeploymentBundle,
  type Environment,
  type FieldMatrixRow,
  type ImageVersionsResponse,
  type OverviewResponse,
  type OverviewRow,
  type ResourceCompareResponse,
  type ResourceKind,
} from "./api";
import "./App.css";

const KIND_LABELS: Record<ResourceKind, string> = {
  deployments: "Deployments",
  statefulSets: "StatefulSets",
  daemonSets: "DaemonSets",
  configMaps: "ConfigMaps",
  secrets: "Secrets",
  services: "Services",
  pvcs: "PVCs",
  ingresses: "Ingresses",
  pdbs: "PodDisruptionBudgets",
  hpas: "HorizontalPodAutoscalers",
};

const CATEGORY_FILTERS: [string, RegExp][] = [
  ["Probes", /\.(livenessProbe|readinessProbe|startupProbe)\./],
  ["Resources/Limits", /\.resources\b/],
  ["Env Vars", /\.(env|envFrom)\b/],
  ["Volumes/Mounts", /\.(volumes|volumeMounts)\b/],
  ["Images", /\.image$/],
  ["Config Data", /^data\b/],
];

export default function App() {
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedContext, setSelectedContext] = useState<string>("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedEnvIds, setSelectedEnvIds] = useState<Set<string>>(new Set());
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [imageVersions, setImageVersions] = useState<ImageVersionsResponse | null>(null);
  const [imageVersionsLoading, setImageVersionsLoading] = useState(false);
  const [imageVersionsError, setImageVersionsError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<{ kind: ResourceKind; canonicalName: string } | null>(null);
  const [fieldMatrix, setFieldMatrix] = useState<ResourceCompareResponse | null>(null);
  const [fieldMatrixLoading, setFieldMatrixLoading] = useState(false);
  const [fieldMatrixError, setFieldMatrixError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const [bundleEnvId, setBundleEnvId] = useState<string>("");
  const [bundleDeployments, setBundleDeployments] = useState<string[]>([]);
  const [bundleDeploymentsLoading, setBundleDeploymentsLoading] = useState(false);
  const [bundleSelectedDeployment, setBundleSelectedDeployment] = useState<string>("");
  const [bundle, setBundle] = useState<DeploymentBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  useEffect(() => {
    api.listContexts().then(setContexts).catch((e) => setError(String(e)));
    api.listEnvironments().then(setEnvironments).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selectedContext) {
      setNamespaces([]);
      return;
    }
    setLoadingNamespaces(true);
    setError(null);
    api
      .listNamespaces(selectedContext)
      .then(setNamespaces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingNamespaces(false));
  }, [selectedContext]);

  async function handleAddEnvironment() {
    if (!selectedContext || !selectedNamespace || !label) return;
    try {
      const env = await api.addEnvironment({
        label,
        context: selectedContext,
        namespace: selectedNamespace,
      });
      setEnvironments((prev) => [...prev, env]);
      setLabel("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRemove(id: string) {
    try {
      await api.removeEnvironment(id);
      setEnvironments((prev) => prev.filter((e) => e.id !== id));
      setSelectedEnvIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleSelected(id: string) {
    setSelectedEnvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCompare() {
    setExpanded(null);
    setFieldMatrix(null);
    setOverview(null);
    setOverviewError(null);
    setOverviewLoading(true);
    try {
      const result = await api.compareOverview(Array.from(selectedEnvIds));
      setOverview(result);
    } catch (e) {
      setOverviewError(String(e));
    } finally {
      setOverviewLoading(false);
    }
  }

  async function handleShowImageVersions() {
    setImageVersions(null);
    setImageVersionsError(null);
    setImageVersionsLoading(true);
    try {
      const result = await api.compareImages(Array.from(selectedEnvIds));
      setImageVersions(result);
    } catch (e) {
      setImageVersionsError(String(e));
    } finally {
      setImageVersionsLoading(false);
    }
  }

  useEffect(() => {
    setBundleSelectedDeployment("");
    setBundle(null);
    setBundleError(null);
    if (!bundleEnvId) {
      setBundleDeployments([]);
      return;
    }
    setBundleDeploymentsLoading(true);
    api
      .listDeployments(bundleEnvId)
      .then(setBundleDeployments)
      .catch((e) => setBundleError(String(e)))
      .finally(() => setBundleDeploymentsLoading(false));
  }, [bundleEnvId]);

  async function handleLoadBundle() {
    if (!bundleEnvId || !bundleSelectedDeployment) return;
    setBundle(null);
    setBundleError(null);
    setBundleLoading(true);
    try {
      const result = await api.getBundle(bundleEnvId, bundleSelectedDeployment);
      setBundle(result);
    } catch (e) {
      setBundleError(String(e));
    } finally {
      setBundleLoading(false);
    }
  }

  async function handleOpenResource(kind: ResourceKind, canonicalName: string) {
    if (expanded?.kind === kind && expanded?.canonicalName === canonicalName) {
      setExpanded(null);
      setFieldMatrix(null);
      return;
    }
    setExpanded({ kind, canonicalName });
    setFieldMatrix(null);
    setFieldMatrixError(null);
    setActiveFilter(null);
    setFieldMatrixLoading(true);
    try {
      const result = await api.compareResource(Array.from(selectedEnvIds), kind, canonicalName);
      setFieldMatrix(result);
    } catch (e) {
      setFieldMatrixError(String(e));
    } finally {
      setFieldMatrixLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo-mark">D8</span>
        <div>
          <h1>D8s</h1>
          <p className="subtitle">Compare Kubernetes resources across environments</p>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Add environment</h2>
        <div className="form-row">
          <select
            className="context-select"
            value={selectedContext}
            title={selectedContext || "Select kubeconfig context"}
            onChange={(e) => {
              setSelectedContext(e.target.value);
              setSelectedNamespace("");
            }}
          >
            <option value="">Select kubeconfig context…</option>
            {contexts.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} {c.isCurrent ? "(current)" : ""}
              </option>
            ))}
          </select>

          <select
            value={selectedNamespace}
            onChange={(e) => setSelectedNamespace(e.target.value)}
            disabled={!selectedContext || loadingNamespaces}
          >
            <option value="">
              {loadingNamespaces ? "Loading namespaces…" : "Select namespace…"}
            </option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder="Label (e.g. prod)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />

          <button
            onClick={handleAddEnvironment}
            disabled={!selectedContext || !selectedNamespace || !label}
          >
            Add
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Environments</h2>
        {environments.length === 0 ? (
          <p className="empty">No environments configured yet.</p>
        ) : (
          <>
            <table className="env-table">
              <thead>
                <tr>
                  <th className="col-check"></th>
                  <th>Label</th>
                  <th>Context</th>
                  <th>Namespace</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {environments.map((env) => (
                  <tr key={env.id}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        checked={selectedEnvIds.has(env.id)}
                        onChange={() => toggleSelected(env.id)}
                      />
                    </td>
                    <td>{env.label}</td>
                    <td>{env.context}</td>
                    <td>{env.namespace}</td>
                    <td>
                      <button className="remove" onClick={() => handleRemove(env.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="action-row">
              <button
                className="compare-btn"
                onClick={handleCompare}
                disabled={selectedEnvIds.size === 0 || overviewLoading}
              >
                {overviewLoading ? "Comparing…" : `Compare Selected (${selectedEnvIds.size})`}
              </button>
              <button
                className="images-btn"
                onClick={handleShowImageVersions}
                disabled={selectedEnvIds.size === 0 || imageVersionsLoading}
              >
                {imageVersionsLoading
                  ? "Loading…"
                  : `Image Versions (${selectedEnvIds.size})`}
              </button>
            </div>
          </>
        )}
      </section>

      {imageVersionsError && <div className="error">{imageVersionsError}</div>}
      {imageVersions && <ImageVersionsView data={imageVersions} />}

      {environments.length > 0 && (
        <section className="card">
          <h2>Deployment Bundle</h2>
          <div className="form-row">
            <select value={bundleEnvId} onChange={(e) => setBundleEnvId(e.target.value)}>
              <option value="">Select environment…</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.label}
                </option>
              ))}
            </select>
            <select
              value={bundleSelectedDeployment}
              onChange={(e) => setBundleSelectedDeployment(e.target.value)}
              disabled={!bundleEnvId || bundleDeploymentsLoading}
            >
              <option value="">
                {bundleDeploymentsLoading ? "Loading deployments…" : "Select deployment…"}
              </option>
              {bundleDeployments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              onClick={handleLoadBundle}
              disabled={!bundleEnvId || !bundleSelectedDeployment || bundleLoading}
            >
              {bundleLoading ? "Loading…" : "View Bundle"}
            </button>
          </div>

          {bundleError && <div className="error">{bundleError}</div>}
          {bundle && <BundleView bundle={bundle} />}
        </section>
      )}

      {overviewError && <div className="error">{overviewError}</div>}

      {overview && (
        <section className="card">
          <h2>Comparison</h2>
          <div className="env-status-row">
            {overview.envs.map((e) => (
              <span key={e.id} className={e.status === "ok" ? "env-badge ok" : "env-badge error"}>
                {e.label} {e.status === "error" ? `— ${e.error}` : ""}
              </span>
            ))}
          </div>

          {RESOURCE_KINDS.filter((k) => overview.kinds[k]?.length > 0).map((kind) => (
            <KindSection
              key={kind}
              kind={kind}
              rows={overview.kinds[kind]}
              envs={overview.envs}
              expanded={expanded}
              onOpenResource={handleOpenResource}
              fieldMatrix={fieldMatrix}
              fieldMatrixLoading={fieldMatrixLoading}
              fieldMatrixError={fieldMatrixError}
              activeFilter={activeFilter}
              onSetFilter={setActiveFilter}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function KindSection({
  kind,
  rows,
  envs,
  expanded,
  onOpenResource,
  fieldMatrix,
  fieldMatrixLoading,
  fieldMatrixError,
  activeFilter,
  onSetFilter,
}: {
  kind: ResourceKind;
  rows: OverviewRow[];
  envs: OverviewResponse["envs"];
  expanded: { kind: ResourceKind; canonicalName: string } | null;
  onOpenResource: (kind: ResourceKind, canonicalName: string) => void;
  fieldMatrix: ResourceCompareResponse | null;
  fieldMatrixLoading: boolean;
  fieldMatrixError: string | null;
  activeFilter: string | null;
  onSetFilter: (f: string | null) => void;
}) {
  return (
    <div className="kind-section">
      <h3>
        {KIND_LABELS[kind]} ({rows.length})
      </h3>
      <div className="overview-table-scroll">
      <table className="overview-table">
        <thead>
          <tr>
            <th>Name</th>
            {envs.map((e) => (
              <th key={e.id}>{e.label}</th>
            ))}
            <th>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isOpen = expanded?.kind === kind && expanded?.canonicalName === row.canonicalName;
            return (
              <Fragment key={row.canonicalName}>
                <tr
                  className="overview-row"
                  onClick={() => onOpenResource(kind, row.canonicalName)}
                >
                  <td className="resource-name">{row.canonicalName}</td>
                  {envs.map((e) => {
                    const present = row.presentEnvIds.includes(e.id);
                    return (
                      <td key={e.id} className={present ? "present" : "missing"}>
                        {present ? "✓" : "—"}
                      </td>
                    );
                  })}
                  <td>
                    {row.diffFieldCount === null ? (
                      <span className="dim">n/a</span>
                    ) : row.diffFieldCount === 0 ? (
                      <span className="ok-text">identical</span>
                    ) : (
                      <span className="diff-badge">{row.diffFieldCount} differ</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={envs.length + 2}>
                      <FieldMatrixView
                        loading={fieldMatrixLoading}
                        error={fieldMatrixError}
                        data={fieldMatrix}
                        envs={envs}
                        activeFilter={activeFilter}
                        onSetFilter={onSetFilter}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function FieldMatrixView({
  loading,
  error,
  data,
  envs,
  activeFilter,
  onSetFilter,
}: {
  loading: boolean;
  error: string | null;
  data: ResourceCompareResponse | null;
  envs: OverviewResponse["envs"];
  activeFilter: string | null;
  onSetFilter: (f: string | null) => void;
}) {
  const [viewMode, setViewMode] = useState<"table" | "yaml">("table");
  const [yamlLeftEnv, setYamlLeftEnv] = useState<string>("");
  const [yamlRightEnv, setYamlRightEnv] = useState<string>("");

  const availableFilters = useMemo(() => {
    if (!data) return [];
    return CATEGORY_FILTERS.filter(([, re]) => data.rows.some((r) => re.test(r.path)));
  }, [data]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    const filterEntry = CATEGORY_FILTERS.find(([name]) => name === activeFilter);
    if (!filterEntry) return data.rows;
    return data.rows.filter((r) => filterEntry[1].test(r.path));
  }, [data, activeFilter]);

  useEffect(() => {
    if (!data) return;
    const presentEnvIds = envs.filter((e) => data.resources[e.id]).map((e) => e.id);
    setYamlLeftEnv(presentEnvIds[0] ?? "");
    setYamlRightEnv(presentEnvIds[1] ?? presentEnvIds[0] ?? "");
  }, [data, envs]);

  if (loading) return <p className="empty">Fetching and comparing fields…</p>;
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  return (
    <div className="field-matrix">
      <div className="view-mode-row">
        <button
          className={viewMode === "table" ? "tab active" : "tab"}
          onClick={() => setViewMode("table")}
        >
          Field Table
        </button>
        <button
          className={viewMode === "yaml" ? "tab active" : "tab"}
          onClick={() => setViewMode("yaml")}
        >
          YAML Diff
        </button>
      </div>

      {viewMode === "yaml" ? (
        <YamlDiffPanel
          data={data}
          envs={envs}
          leftEnv={yamlLeftEnv}
          rightEnv={yamlRightEnv}
          onSetLeftEnv={setYamlLeftEnv}
          onSetRightEnv={setYamlRightEnv}
        />
      ) : (
        <>
      {availableFilters.length > 0 && (
        <div className="filter-row">
          <button
            className={activeFilter === null ? "tab active" : "tab"}
            onClick={() => onSetFilter(null)}
          >
            All ({data.rows.length})
          </button>
          {availableFilters.map(([name, re]) => (
            <button
              key={name}
              className={activeFilter === name ? "tab active" : "tab"}
              onClick={() => onSetFilter(name)}
            >
              {name} ({data.rows.filter((r) => re.test(r.path)).length})
            </button>
          ))}
        </div>
      )}
      <div className="field-matrix-scroll">
        <table className="field-table">
          <thead>
            <tr>
              <th>Path</th>
              {envs.map((e) => (
                <th key={e.id}>{e.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row: FieldMatrixRow) => (
              <tr key={row.path} className={row.differs ? "differs" : ""}>
                <td className="path-cell">{renderPath(row.path)}</td>
                {envs.map((e) => {
                  const cell = row.cells[e.id];
                  return (
                    <td key={e.id}>
                      {!cell || !cell.present ? (
                        <span className="dim">—</span>
                      ) : (
                        <code>{formatValue(cell.value)}</code>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

function YamlDiffPanel({
  data,
  envs,
  leftEnv,
  rightEnv,
  onSetLeftEnv,
  onSetRightEnv,
}: {
  data: ResourceCompareResponse;
  envs: OverviewResponse["envs"];
  leftEnv: string;
  rightEnv: string;
  onSetLeftEnv: (id: string) => void;
  onSetRightEnv: (id: string) => void;
}) {
  const leftYaml = useMemo(
    () => YAML.stringify(data.resources[leftEnv] ?? { "(not present in this environment)": null }),
    [data, leftEnv],
  );
  const rightYaml = useMemo(
    () => YAML.stringify(data.resources[rightEnv] ?? { "(not present in this environment)": null }),
    [data, rightEnv],
  );

  return (
    <div className="yaml-diff-panel">
      <div className="yaml-env-pickers">
        <select value={leftEnv} onChange={(e) => onSetLeftEnv(e.target.value)}>
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <span className="vs">vs</span>
        <select value={rightEnv} onChange={(e) => onSetRightEnv(e.target.value)}>
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div className="monaco-wrapper">
        <DiffEditor
          height="480px"
          language="yaml"
          original={leftYaml}
          modified={rightYaml}
          theme="vs"
          options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
        />
      </div>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Splits a field path on "." and inserts <wbr> between segments, so long paths
 * prefer wrapping at natural boundaries instead of breaking mid-word. */
function renderPath(path: string) {
  const segments = path.split(".");
  return segments.map((segment, i) => (
    <span key={i}>
      {i > 0 && "."}
      {i > 0 && <wbr />}
      {segment}
    </span>
  ));
}

function BundleView({ bundle }: { bundle: DeploymentBundle }) {
  const danglingNames = new Set(bundle.dangling.map((d) => `${d.kind}:${d.name}`));
  const forwardByKind = groupBy(bundle.forward, (e) => e.kind);
  const reverseByKind = groupBy(bundle.reverse, (e) => e.kind);

  return (
    <div className="bundle-view">
      <div className="bundle-column">
        <h3>Uses</h3>
        {bundle.forward.length === 0 && <p className="empty">No references found.</p>}
        {Object.entries(forwardByKind).map(([kind, edges]) => (
          <div key={kind} className="bundle-group">
            <h4>{kind}</h4>
            <ul>
              {edges.map((e, i) => {
                const isDangling = danglingNames.has(`${e.kind}:${e.name}`);
                return (
                  <li key={i} className={isDangling ? "dangling" : ""}>
                    <span className="edge-name">{e.name}</span>
                    <span className="edge-usage">{e.usage}</span>
                    {isDangling && <span className="missing-badge">MISSING</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="bundle-column">
        <h3>Used By</h3>
        {bundle.reverse.length === 0 && <p className="empty">Nothing references this deployment.</p>}
        {Object.entries(reverseByKind).map(([kind, edges]) => (
          <div key={kind} className="bundle-group">
            <h4>{kind}</h4>
            <ul>
              {edges.map((e, i) => (
                <li key={i}>
                  <span className="edge-name">{e.name}</span>
                  <span className="edge-usage">{e.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

function ImageVersionsView({ data }: { data: ImageVersionsResponse }) {
  return (
    <section className="card">
      <h2>Image Versions</h2>
      <div className="env-status-row">
        {data.envs.map((e) => (
          <span key={e.id} className={e.status === "ok" ? "env-badge ok" : "env-badge error"}>
            {e.label} {e.status === "error" ? `— ${e.error}` : ""}
          </span>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <p className="empty">No deployments found.</p>
      ) : (
        <div className="overview-table-scroll">
          <table className="overview-table image-versions-table">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>Container</th>
                {data.envs.map((e) => (
                  <th key={e.id}>{e.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`${row.deployment}/${row.container}`} className={row.differs ? "differs" : ""}>
                  <td className="resource-name">{row.deployment}</td>
                  <td className="resource-name">
                    {row.container}
                    {row.isInit && <span className="init-badge">init</span>}
                  </td>
                  {data.envs.map((e) => {
                    const image = row.images[e.id];
                    return (
                      <td key={e.id} className="image-cell">
                        {image === null ? <span className="dim">—</span> : <code>{image}</code>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
