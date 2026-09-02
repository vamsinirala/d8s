# D8s — Multi-Environment Kubernetes Diff Tool

A local web app that compares Kubernetes resources (configs, secrets, probes, volume
mounts, resources/limits, images, etc.) across multiple environments, and against
rendered Helm charts. Runs on Mac and Windows, opens in the browser.

## Core concept

**Environment = (kubeconfig context, namespace) pair.**

This one abstraction covers every comparison mode: different clusters, different
namespaces in the same cluster, or any mix. The user defines N environments and every
view compares across all N at once — never just pairwise.

A **Helm-rendered chart is a virtual environment**: `helm template` output, normalized
the same way as live resources, mounted as one more column in the matrix. Chart-vs-live
drift falls out of the same diff engine — no separate feature.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node + TypeScript, Fastify | Serves JSON API + built frontend from one process on localhost; opens browser via `open` pkg |
| K8s access | `@kubernetes/client-node` v2 | Official client. AppsV1Api, CoreV1Api, NetworkingV1Api, PolicyV1Api, AutoscalingV2Api. Supports exec auth (needed for EKS `aws eks get-token`) |
| Helm | shell out to `helm template` | User has Helm 4 installed (v4.1.1 verified locally). Parse multi-doc YAML with `yaml` pkg |
| Frontend | Vite + React + TypeScript | |
| Matrix UI | TanStack Table | rows = field paths, columns = environments |
| YAML diff view | `@monaco-editor/react` DiffEditor | side-by-side normalized YAML |

Local environment (verified 2026-08-28): Node v25.8.1, npm 11.11.0, Helm v4.1.1.
Available test contexts: two EKS clusters (ap-south-1, us-east-2) and one AKS
cluster.

## Repo layout

```
D8s/
├── PLAN.md
├── server/
│   ├── index.ts            # Fastify app: API + static UI, browser auto-open
│   ├── k8s/
│   │   ├── contexts.ts     # list kubeconfig contexts, namespaces
│   │   ├── fetch.ts        # fetch resources per env (concurrent)
│   │   └── normalize.ts    # strip noise fields, flatten to path→value
│   ├── diff/
│   │   ├── engine.ts       # N-way field-level diff, identity matching
│   │   └── secrets.ts      # SHA-256 hashing of secret values
│   ├── graph/
│   │   └── resolve.ts      # deployment bundle: forward/reverse refs, label-selector evaluator
│   └── helm/
│       └── render.ts       # helm template subprocess → virtual env
└── web/                    # Vite React app
```

## Design decisions (load-bearing)

### 1. Normalized comparison model — never diff raw YAML pairwise

1. **Fetch** each resource from each env.
2. **Normalize** — strip noise: `status`, `metadata.managedFields`, `resourceVersion`,
   `uid`, `creationTimestamp`, `generation`, `kubectl.kubernetes.io/last-applied-configuration`
   annotation, cluster-injected defaults.
3. **Match identities across envs** by `kind/name`, with configurable alias rules
   (strip env prefixes/suffixes, e.g. `payments-dev` ↔ `payments-prod`).
4. **Flatten to path → value maps** and pivot: rows = field paths
   (`spec.template.spec.containers[app].livenessProbe.initialDelaySeconds`),
   columns = environments. **Containers keyed by name, not array index** — reordering
   must not be a false diff. Same for env vars, volumes, volumeMounts, ports.

The pivot matrix is the product — the view no existing tool has.

### 2. Secrets: hashes by default

Compare SHA-256 of each value. Matrix shows same / differs / missing-key without
plaintext ever reaching the browser. Revealing a value is explicit per-value opt-in.
Build this in from the start; do not retrofit.

### 3. Helm as virtual environment

Env config can point at a chart dir + values file(s) instead of a cluster.
`helm template` → parse → normalize → same pipeline. Structured errors and
per-resource provenance are lost vs. in-process rendering (Go-only), acceptable
tradeoff for staying in Node.

## Feature: Deployment bundle view

User picks environment + Deployment → tool builds the full reference graph →
optionally compares the whole bundle across other envs in the same matrix.

### Forward references (what the deployment uses) — exact name refs, walk pod template

- ConfigMaps: `env[].valueFrom.configMapKeyRef`, `envFrom[].configMapRef`,
  `volumes[].configMap`, `volumes[].projected.sources[].configMap`
- Secrets: same four paths + `imagePullSecrets[]`
- PVCs: `volumes[].persistentVolumeClaim`
- ServiceAccount: `serviceAccountName` (+ its `imagePullSecrets`, second hop)
- PriorityClass: `priorityClassName`
- Walk `initContainers` AND `containers`
- Record usage location per ref ("Secret db-creds → mounted at /etc/db in container app"
  vs "→ env DB_PASSWORD") — the location itself is diffable.

### Reverse references (what points at the deployment) — selector matching

- Services: `spec.selector` (plain equality map) ⊆ pod template labels
- PDBs: `spec.selector` — FULL label-selector semantics (`matchLabels` + `matchExpressions`)
- HPA: `spec.scaleTargetRef` names the Deployment (exact)
- NetworkPolicies: `spec.podSelector` matches
- Ingresses: second hop — routes to a Service that matched above

All from the already-fetched namespace snapshot — in-memory matching, no extra API
calls. Works identically for the Helm virtual env ("what does the chart think this
bundle is vs. live").

Free win: **dangling reference detection** — referenced ConfigMap/Secret that doesn't
exist shows as broken (common real-world env bug).

Needs one shared utility: a correct label-selector evaluator (~50 lines, used by
PDB/NetworkPolicy/Service matching).

Out of scope v1: RBAC (RoleBindings → ServiceAccount) — same pattern but users may
lack read permission; degrade gracefully.

## Build phases

- [x] **Phase 1 — Scaffold.** Monorepo (`server/` + `web/`), Fastify serving Vite build,
      browser auto-open, single `npm run dev`. Pinned `@kubernetes/client-node` to
      `1.4.0` (v2.0.0 is a ~1-week-old ground-up rewrite, too new to build on). Pinned
      `@fastify/static` to `^10.1.3` (path-traversal CVE in earlier resolved version).
- [x] **Phase 2 — Environment discovery.** API: list contexts, list namespaces per
      context. UI: define envs (context + namespace + friendly label), persisted to
      `~/.d8s/environments.json`. ✅ Verified against real infra: both EKS (AWS exec
      auth) and AKS (kubelogin device-code exec auth) contexts correctly invoke their
      auth plugins; namespaces fetched live from both EKS clusters;
      add/persist/display round-tripped successfully.
- [x] **Phase 3 — Fetch + normalize.** Deployments, StatefulSets, DaemonSets, ConfigMaps,
      Secrets, Services, PVCs, Ingresses, PDBs, HPAs per env, concurrently
      (`server/src/k8s/fetch.ts`). Normalizer strips status + metadata bookkeeping,
      re-keys containers/env/ports/volumeMounts by name, and strips noisy annotations
      **at every depth** (`server/src/k8s/normalize.ts`). Secret `data`/`stringData`
      never leaves the fetch layer as-is (stripped before normalization; proper
      per-value hashing still to come in the diff engine, Phase 4).
      ✅ Verified against real production data (a live app namespace: 5 deployments,
      8 configmaps, 5 secrets, 8 services, 2 ingresses): container/env re-keying
      confirmed correct, non-name-keyed arrays (`envFrom`) correctly left alone,
      zero `status`/`managedFields`/secret-data leakage across the full snapshot.
      🐛 Found & fixed: noise-annotation stripping only ran on the resource's
      top-level `metadata`, missing `spec.template.metadata.annotations` — the pod
      template's own annotations, where `kubectl.kubernetes.io/restartedAt` actually
      lives. Real prod data had this annotation and would have caused a false diff
      any time one env was restarted more recently than another. Fixed by filtering
      annotations generically at every tree depth instead of only at the root.
- [x] **Phase 4 — Diff engine.** `server/src/diff/engine.ts`: `canonicalName()` strips
      an env's own label from a resource name as a whole token (`payments-dev-app` +
      label `dev` → `payments-app`); `buildOverview()` matches resources across N envs
      and scores field-diff count per match; `buildFieldMatrix()` pivots one matched
      resource into path × env cells. `server/src/diff/secrets.ts` hashes secret
      `data`/`stringData` values (sha256, 12 hex chars) before they ever reach
      normalization — equality is comparable, plaintext never leaves the fetch layer.
      API: `POST /api/compare/overview` and `POST /api/compare/resource`, both using
      `Promise.allSettled` so one environment's auth failure (e.g. AKS device-code
      timeout) doesn't take down the whole comparison — failed envs report
      `status:"error"` with the message, successful ones still compare normally.
      ✅ Verified against real dev/prod/stage namespace pairs on a live EKS cluster:
      - dev vs prod for one app: `app-dev-orders-ext-api` correctly matched to
        `app-orders-ext-api` via label-stripping (33 field diffs); an exact-name
        match found 8 diffs including
        **dev has zero resource limits/requests configured while prod has explicit
        cpu/memory limits** — a real, useful drift finding.
      - a second app's dev vs prod: dev namespace is essentially
        empty (0 deployments) — correctly reported as such, not a fetch bug.
      🐛 Found & fixed via a stage-vs-prod pair: a resource named
      identically in both namespaces (`app-orders-api-stage`) was being split into
      two separate rows, because label-stripping removed the `-stage` token from the
      stage-side copy (its own env label) but left the prod-side copy untouched (its
      label is `prod`, not `stage`) — so an exact match was destroyed by asymmetric
      stripping. Fixed with two-pass matching: identical raw names across envs always
      win as a match first; label-stripped canonicalization is only a fallback for
      names that don't already match exactly.
      Frontend: `web/src/App.tsx` fully replaced the Phase 3 single-env viewer with
      the real compare flow — checkbox-select environments, "Compare Selected",
      per-kind overview tables (name × env presence + diff-count badge), click a row
      to drill into the field-level matrix with category filters (Probes,
      Resources/Limits, Env Vars, Volumes/Mounts, Images, Config Data). Env fetch
      failures show inline per-environment (`env-badge error`) rather than blocking
      the rest of the comparison.
      ✅ UI verified in-browser via checkbox → Compare Selected on a real saved
      stage/prod namespace pair; hit an
      expired AWS SSO session mid-verification (`aws eks get-token` failing with an
      OAuth error even though `aws sts get-caller-identity` succeeds — a stale
      EKS-specific SSO token, not a code issue) which incidentally became a live
      confirmation that the graceful-degradation path works end-to-end in the actual
      browser, not just in the API. Engine correctness itself was already confirmed
      moments earlier via direct script calls against this exact same pair while the
      session was still valid.
      **Phase 4 complete.**
- [x] **Phase 5 — Deployment bundle view.** `server/src/graph/resolve.ts`: forward refs
      (ConfigMap/Secret/PVC/ServiceAccount/PriorityClass, walking containers +
      initContainers + volumes + imagePullSecrets, each edge labeled with its usage
      location), reverse refs (Service/PDB/HPA/Ingress via label-selector or
      scaleTargetRef matching, with a spec-correct `V1LabelSelector` evaluator —
      matchLabels + matchExpressions incl. In/NotIn/Exists/DoesNotExist — plus the
      simpler plain-map selector Services actually use), dangling-reference detection.
      API: `GET /api/environments/:id/deployments` (names for the picker) and
      `GET /api/environments/:id/deployments/:name/bundle`. Frontend: `BundleView` —
      env + deployment pickers, two-column Uses/Used-By grouped by kind, dangling refs
      flagged with a MISSING badge.
      ✅ Verified against real production data end-to-end (API via curl, then the same
      result reproduced through the actual browser UI): a live `api` deployment →
      correctly resolved `api-config`/`api-secrets` (envFrom), a registry secret
      (imagePullSecrets), `api-sa` (serviceAccountName) forward, and `api-service` →
      ingress reverse chain; dangling-detection logic separately confirmed
      with a synthetic missing-reference case.
      🐛 Found & fixed: a long unbroken string (an EKS ARN with no spaces) was
      overflowing its `table-layout:fixed` cell and visually overlapping the next
      column — fixed with `overflow-wrap: anywhere` on all table cells.
- [x] **Phase 6 — YAML drill-down.** `@monaco-editor/react` + `yaml` added to `web`.
      `FieldMatrixView` now has a Field Table / YAML Diff toggle; YAML mode adds two
      env pickers (defaulting to the first two present envs) and renders
      `<DiffEditor>` read-only, side-by-side, over `YAML.stringify()` of the full
      normalized resource body. Server: `/api/compare/resource` extended to return
      `resources: Record<envId, body|null>` alongside the existing flattened `rows`,
      since the field-matrix rows alone aren't enough to reconstruct real YAML.
      ⚠️ **Verification blocked**: partway through testing, the AWS SSO session
      expired across *all* configured EKS contexts simultaneously (not just the one
      hit earlier) — every `compare`/`bundle` call now fails with the same
      `CreateOAuth2Token` error regardless of cluster. This is your AWS session, not
      a code issue (confirmed: type-checks clean, a fresh browser tab shows zero
      console errors, and the compare/bundle UI has already round-tripped real data
      successfully multiple times earlier in this session — including the exact
      `resources` field this phase added, confirmed present and correctly `null`
      when a fetch fails). Re-run `aws sso login` (or equivalent) and re-open the
      "Deployment Bundle" or "Compare Selected" flow to pick up where this left off.
      Also noted: `@monaco-editor/react`'s `monaco-editor` dependency pulls in a
      `dompurify` version with known XSS advisories; the only available fix requires
      a monaco-editor *dev/pre-release* build, so left unpatched for now — real-world
      exposure here is low since we only render our own YAML in a read-only diff, not
      arbitrary HTML/Markdown through Monaco's hover/completion widgets. Revisit once
      monaco-editor ships a stable release pinning a patched dompurify.
- [ ] **Phase 7 — Helm comparison.** Chart dir + values per env → `helm template` →
      virtual env column.
- [ ] **Phase 8 — Polish.** Export report (HTML/Markdown), refresh, auth-failure error
      surfaces, `npx d8s` packaging.

## Post-Phase-6 additions

- **Image Versions report**: a dedicated "Image Versions" button (next to "Compare
  Selected") lists every deployment × container's image tag across the selected
  environments in one table — the quick "did the version actually change" view,
  distinct from drilling into one deployment's full field diff.
  Backend: `matchAcrossEnvironments()` extracted out of `buildOverview()` in
  `server/src/diff/engine.ts` as a standalone, reusable matcher (same validated
  two-pass exact-then-canonical logic), with a new `extractContainerImages()` walking
  each matched deployment's `containers`/`initContainers` (name-keyed post-normalize)
  for the `.image` field. New endpoint `POST /api/compare/images`. Frontend:
  `ImageVersionsView` in `web/src/App.tsx`.
  Deliberately distinguishes two different states per row: **version differs**
  (highlighted) vs. **only deployed in one environment** (dash, not highlighted) —
  a deployment missing from one env isn't a version mismatch, it's a presence gap.
  ✅ Verified against real production data (kube-stage vs kube-prod): correctly
  flagged real version drift on 3 of 6 deployments, correctly left 3 env-exclusive
  deployments unhighlighted.

## Post-Phase-6 fixes

- **Field-table path overflow**: long field paths (common — e.g.
  `spec.template.spec.containers.<name>.env.<VAR_NAME>.valueFrom.secretKeyRef.name`
  routinely exceeds 80 chars) were rendered with `white-space: nowrap`, forcing the
  whole row — including the actually-useful value columns — far off-screen behind
  horizontal scroll. Fixed in two parts: (1) CSS — `.field-table td.path-cell` now
  allows wrapping with `overflow-wrap: anywhere` and a `max-width`, so the path
  column wraps instead of pushing the table wide; (2) `renderPath()` in
  `web/src/App.tsx` splits the path on `.` and inserts `<wbr>` between segments, so
  wrapping prefers the natural dot boundaries over breaking mid-identifier.
  Verified against real long paths in production data (SPRING_DATASOURCE_* env var
  chains) — values are now fully visible without horizontal scroll, breaks land at
  `.`/`-` boundaries, not mid-word.

## Post-image-versions fixes

- **Comparison table page-level horizontal overflow**: `.overview-table` used
  `table-layout: auto`, which sizes columns from descendant content. When a row's
  field-matrix drill-down was expanded (nested inside a `colSpan` cell) and
  contained a genuinely wide, unwrapped value (e.g. a long DB connection string —
  seen for real at ~1075px in one column), that width propagated *upward* through
  the auto-layout table, past its own `.overview-table-scroll` wrapper (which
  cannot constrain a table that's computing its own width from content), all the
  way out to `document.body` — the whole page gained a horizontal scrollbar instead
  of just the intended inner region. Root cause confirmed by direct measurement:
  `document.body.scrollWidth` (1324px) exceeded `window.innerWidth` (1263px) with 3
  environments selected. Fixed by switching `.overview-table` to
  `table-layout: fixed` (same pattern already used for the Environments table and
  `.field-table`) — this makes the outer table's column widths depend only on its
  own allotted space, not on nested content, breaking the upward propagation.
  ✅ Verified: after the fix, `body.scrollWidth === window.innerWidth` (no more
  page-level overflow) while the inner field-matrix drill-down still correctly
  overflows and scrolls *within its own bounds* (1813px content in a 1014px
  container, `overflow-x: auto` still functioning) — wide values remain fully
  visible via scroll exactly where expected, without breaking the outer layout.

## UI revamp

Full visual redesign of `web/src/App.css` (design-token system) plus light structural
additions in `web/src/App.tsx` (`.app-header` with a logo mark, `.card` on every
`<section>`, `.env-table` class on the Environments table). No behavioral/logic
changes — this was a pure styling + minor-structure pass.

- **Design tokens**: CSS custom properties in `:root` for color (neutral grays +
  indigo primary + semantic success/danger/warning), spacing radius scale, shadows,
  and font stacks. Added Inter (UI) + JetBrains Mono (code/paths/values) via Google
  Fonts in `web/index.html`; set page `<title>` to "D8s" (was the Vite default "web").
- **Header**: gradient logo mark ("D8" square) + title/subtitle.
- **Cards**: every section is now a bordered, rounded, subtly-shadowed card instead
  of a bare block with just an underlined heading.
- **Buttons/inputs**: consistent rounded corners, focus-visible ring (accessibility),
  hover states, disabled state uses neutral gray instead of a dimmed color.
- **Tabs** (Field Table/YAML Diff, category filters): restyled as a segmented
  control — gray pill track, active tab is a white pill with a soft shadow.
- **Badges/pills**: env status, diff count, missing/init markers all restyled with
  soft-tint backgrounds + matching darker text (success/danger/warning semantic
  colors) instead of flat saturated colors.
- 🐛 **Found & fixed during the revamp**: the Environments table (plain `<table>`,
  no dedicated class) had no `table-layout`, so the browser's auto-layout algorithm
  over-allocated width to the long Context/ARN column, squeezing the Label and
  Remove-button columns down to ~100px — narrow enough that "Remove" wrapped to two
  lines. Fixed by adding an `.env-table` class with `table-layout: fixed` and
  explicit column-width percentages (Label 16%, Context 48%, Namespace 22%, action
  90px), plus `white-space: nowrap` on the base `button` rule as a general safeguard
  against button labels ever wrapping.
  ✅ **Verified across every view**: header/forms/environments table directly
  against the live app; the Comparison overview table, field-matrix drill-down
  (both Field Table and YAML Diff/Monaco sub-views), Image Versions table, and
  Deployment Bundle view were all verified by temporarily mocking `window.fetch`
  client-side with realistic data shapes captured from earlier real API responses
  — necessary because AWS SSO/rate-limiting made live cluster data unavailable
  mid-verification (see below). The mock was removed via page reload immediately
  after; no code artifact from it remains.

## Screen real-estate fix

The Vite scaffold's `web/src/index.css` had never been replaced during the UI
revamp, and it was silently fighting `App.css`:

- `#root { width: 1126px; text-align: center; border-inline: 1px solid }` capped
  the whole app at 1126px (narrower than `.app`'s own 1200px, which therefore never
  applied), centered every heading, and drew stray vertical border lines down the
  page. At 1920px, only 59% of the viewport was used.
- `:root { font: 18px ... }` inflated every rem-based size ~12%.
- `color-scheme: light dark` plus a dark-mode palette whose token names collided
  with App.css's (`--text`, `--bg`, `--border`) made OS-dark-mode form controls
  render dark against the light design.

Fix: `index.css` rewritten as a minimal reset (box-sizing, zero margins,
`color-scheme: light`, `#root { min-height: 100svh }` only); `.app` widened from
`max-width: 1200px` to `1720px` with adjusted padding.
✅ Verified at 1920px (width usage 59% → 90%, headings left-aligned, no scaffold
borders, comparison/field-diff tables spread properly) and at 1366px (100% width,
no horizontal overflow, environment ARNs now fit on one line).

## Dependency/size trim

Removed everything installed-but-unused:
- `yaml` from **server** deps — zero imports in `server/src`; it was added for the
  never-built Helm phase (web's `yaml` stays — used by the YAML diff view).
- `oxlint` from **web** devDeps (12MB native binary) plus its `.oxlintrc.json` and
  the scaffold `lint` script — never configured or run.
- Unreferenced Vite scaffold files: `web/src/assets/` (hero.png, react.svg,
  vite.svg), `web/public/icons.svg`, `web/README.md`.
- Added `.claude/` to `.gitignore` — the preview launcher keeps auto-recreating it.

node_modules: 293MB → 279MB. Working tree (excl. node_modules/.git): 1.6MB.
✅ Verified after prune: server tsc clean, full web production build clean
(bundle: 323KB JS / 100KB gzipped — monaco-editor's 98MB stays in node_modules as
a dev-only types peer; at runtime Monaco loads from CDN and is NOT bundled).
Remaining node_modules weight is dominated by dev tooling (typescript 23MB,
rolldown 16MB, esbuild 10MB, lightningcss 8MB, monaco 98MB) and the one big
runtime dep, `@kubernetes/client-node` (56MB generated client + 11MB rxjs
transitive) — none removable without breaking builds or the k8s client.
A production-only install (`npm install --omit=dev` for the server workspace)
lands around 80–90MB, client-node dominated.

## Release bundling

`scripts/release.sh [version]` builds a self-contained, lift-and-shift bundle:
`server/dist` + `web/dist` + a minimal runtime `package.json` + production-only
`node_modules` (installed fresh into the stage via `npm install --omit=dev`),
plus `start.sh` / `start.cmd` launchers and a README.txt. Layout preserves the
`server/dist/../../web/dist` relative path the server's static-serving expects.
All runtime deps are pure JS, so ONE tarball runs on macOS/Linux/Windows —
target machine needs only Node 20+ (and kubeconfig/auth plugins, as always).

`.github/workflows/release.yml` runs it on any `v*` tag push and attaches the
tarball to a GitHub Release via `gh release create --generate-notes` (uses the
built-in GITHUB_TOKEN, `contents: write`; no third-party actions).

Result: **10MB tarball** (90MB unpacked, client-node dominated).
✅ Verified end-to-end locally: built the bundle, extracted to a clean temp dir,
ran `NODE_ENV=production D8S_API_PORT=4599 node server/dist/index.js` — UI
serves (200, correct title), `/api/environments` returns real data, browser
auto-open fired. `release/` is gitignored.

To cut a release: bump version in package.json if desired, then
`git tag v0.1.0 && git push origin v0.1.0`.

## Known risks / gotchas

- ✅ EKS exec auth from `@kubernetes/client-node` — tested in Phase 2. Both AWS
  (EKS) and Azure (`kubelogin` device-code, AKS) exec plugins invoke correctly;
  auth errors (expired SSO session, expired device code) surface cleanly rather
  than being swallowed.
- Alias rules for identity matching need real-world tuning (env-suffixed names).
- Selector matching must implement true k8s semantics, not naive map equality.
- Normalization list will grow — expect iteration when real clusters inject defaults
  (e.g. default `imagePullPolicy`, `terminationMessagePath`, tolerations added by
  admission controllers). Confirmed pattern from Phase 3: noise can hide at any
  nesting depth (pod template annotations vs. resource-level annotations) — any
  future noise-stripping rule needs to walk the whole tree, not just top-level
  `metadata`, or it'll miss real cases silently.
- `npm install --no-save <pkg>` run from the monorepo root installs into the
  **root** `node_modules` regardless of which workspace actually depends on it —
  it does not respect workspace boundaries the way a scoped `npm install -w
  <workspace> <pkg>` does. Left a stray `@kubernetes/client-node@2.0.0` in
  `server/node_modules` that conflicted with the real `1.4.0` pin; fixed with a
  full clean reinstall (`rm -rf node_modules */node_modules package-lock.json &&
  npm install`). Prefer `npm install -w <workspace> <pkg>` (or edit package.json
  directly and run a plain `npm install`) over ad-hoc `--no-save` probes in a
  workspace repo — reserve `--no-save` installs for a true scratch/throwaway dir.
- The preview/dev-server harness injects `PORT=<launch.json port>` into the whole
  `npm run dev` process tree. Since this app runs two servers (Vite frontend +
  Fastify API), naming the API server's port env var `PORT` collided with the
  harness's injected value and made both processes fight over the same port.
  Fixed by reading `D8S_API_PORT` instead of `PORT` for the backend. Any future
  additional service/process in this repo should use its own distinctly-named
  env var for its port, never the bare `PORT`.
- The Browser-pane tools (`read_page`/`form_input`) return refs that snapshot a
  point in time; calling two of them **in parallel** against the same page risks
  a stale-ref race if React re-renders between the snapshot and the action (seen
  firsthand adding the first two environments — a parallel `form_input` +
  `javascript_tool` call landed on the wrong `<option>`). Drive multi-step form
  interactions in this app sequentially, not in parallel, when testing via the
  browser tools.
