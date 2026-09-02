import { createHash } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";

/**
 * Never let plaintext or base64 secret values leave the fetch layer. Each value is
 * replaced by a short hash: equal secrets across environments still show as
 * identical, and different ones show as differing, but no content is ever exposed.
 */
function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function hashMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return map;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, hashValue(value)]));
}

export function hashSecretData(secret: V1Secret): V1Secret {
  return {
    ...secret,
    data: hashMap(secret.data),
    stringData: hashMap(secret.stringData),
  };
}
