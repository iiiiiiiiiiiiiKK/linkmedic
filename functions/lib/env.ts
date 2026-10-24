export interface Env {
  /** KV namespace used for the rate-limit counters. Optional: the API degrades gracefully. */
  LINKMEDIC_KV?: KVNamespace;
  /** Optional hard override for the per-IP request budget per window. */
  LINKMEDIC_RATE_LIMIT?: string;
  /** Optional override for the allowed link-probe ceiling. */
  LINKMEDIC_MAX_LINKS?: string;
}
