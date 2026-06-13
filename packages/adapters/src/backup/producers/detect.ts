/**
 * Producer auto-detection — picks a payload kind from service.image when
 * `backup_policy.payload_kind === 'auto'`. Chunk 1 returns 'volume'
 * unconditionally; Chunk 3 adds DB-specific regex matches inside the
 * concrete producer's `detects()` method.
 *
 * The registry's `resolveProducerForService` walks producers in
 * registration order — that's the actual detection mechanism. This
 * file is intentionally small; its only job is making the
 * detect-policy intent visible to readers of the orchestrator.
 */

import type { BackupProducer, ServiceHandle } from "../types";
import { resolveProducerForService } from "../registry";

/**
 * Resolve the producer the orchestrator should use for a service when
 * the policy specifies `payloadKind: 'auto'`. Just delegates to the
 * registry; this function exists so the orchestrator can stay
 * registry-agnostic later if we want a different policy.
 */
export function autoDetectProducer(service: ServiceHandle): BackupProducer {
  return resolveProducerForService(service);
}
