/**
 * Extract a safe string description from an unknown caught value.
 *
 * Why: ssh2, the AWS SDK, and other libraries attach credentials and
 * full request/response objects to their Error subclasses. Passing
 * those Error objects to console.error logs the entire object graph —
 * including private keys, signed headers, and bucket configs — into
 * log aggregators (Datadog, Loki, sometimes shared with vendors).
 *
 * `String(err)` / `err.message` strips the structured fields and keeps
 * only what's safe to surface: the human-readable message string.
 * Non-Error values fall through to `String()` so we never throw inside
 * a catch block.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // err.message strips associated metadata that SDKs attach to the
    // Error object (e.g. ssh2's `level`, AWS's `$metadata`, request
    // bodies). Bound to 2000 chars so a deeply nested message can't
    // bloat the log entry.
    return err.message.slice(0, 2000);
  }
  return String(err).slice(0, 2000);
}
