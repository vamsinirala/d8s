import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type IgnoreRule, type OverviewRow } from "./api";

/**
 * Ignore rules, applied in the browser.
 *
 * Rules are stored by the server (~/.d8s/ignores.json) but matched here, against
 * the paths the overview already returns. That keeps ignoring instant (no
 * refetch) and leaves both cluster-data caches valid, since cached responses
 * never have ignores baked in.
 */

/** A rule's path covers itself and anything nested beneath it. */
function pathMatches(rulePath: string, path: string): boolean {
  return path === rulePath || path.startsWith(`${rulePath}.`);
}

function appliesTo(rule: IgnoreRule, kind: string, resource: string): boolean {
  return rule.kind === kind && (rule.resource === null || rule.resource === resource);
}

export function isResourceIgnored(rules: IgnoreRule[], kind: string, resource: string): boolean {
  return rules.some((r) => r.path === null && appliesTo(r, kind, resource));
}

export function isPathIgnored(
  rules: IgnoreRule[],
  kind: string,
  resource: string,
  path: string,
): boolean {
  return rules.some((r) => r.path !== null && appliesTo(r, kind, resource) && pathMatches(r.path, path));
}

/** Differing/missing field counts for an overview row, after ignore rules. */
export function effectiveCounts(
  rules: IgnoreRule[],
  kind: string,
  row: OverviewRow,
): { value: number; missing: number; ignored: number } | null {
  if (row.valuePaths === null || row.missingPaths === null) return null;
  const keep = (p: string) => !isPathIgnored(rules, kind, row.canonicalName, p);
  const value = row.valuePaths.filter(keep).length;
  const missing = row.missingPaths.filter(keep).length;
  return {
    value,
    missing,
    ignored: row.valuePaths.length + row.missingPaths.length - value - missing,
  };
}

interface IgnoreContextValue {
  rules: IgnoreRule[];
  add: (rule: { kind: string; resource: string | null; path: string | null }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  error: string | null;
}

const IgnoreContext = createContext<IgnoreContextValue>({
  rules: [],
  add: async () => {},
  remove: async () => {},
  clear: async () => {},
  error: null,
});

export function IgnoreProvider({ children }: { children: React.ReactNode }) {
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listIgnores().then(setRules).catch((e) => setError(String(e)));
  }, []);

  const add = useCallback<IgnoreContextValue["add"]>(async (input) => {
    try {
      const rule = await api.addIgnore(input);
      setRules((prev) => (prev.some((r) => r.id === rule.id) ? prev : [...prev, rule]));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await api.removeIgnore(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await api.clearIgnores();
      setRules([]);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const value = useMemo(() => ({ rules, add, remove, clear, error }), [rules, add, remove, clear, error]);
  return <IgnoreContext.Provider value={value}>{children}</IgnoreContext.Provider>;
}

export function useIgnores(): IgnoreContextValue {
  return useContext(IgnoreContext);
}

/** The rules responsible for hiding a path, so "Unignore" removes exactly those. */
export function rulesCoveringPath(
  rules: IgnoreRule[],
  kind: string,
  resource: string,
  path: string,
): IgnoreRule[] {
  return rules.filter((r) => r.path !== null && appliesTo(r, kind, resource) && pathMatches(r.path, path));
}
