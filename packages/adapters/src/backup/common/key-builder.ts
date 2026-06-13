/**
 * Destination key paths for backup artifacts.
 *
 * Format (relative to destination.pathPrefix):
 *   openship/<projectSlug>/<serviceName>/<runId>/<artifactName>
 *
 * Why this layout:
 *   - User-readable hierarchy: ops can hand-restore by browsing the bucket.
 *   - RunId in the path makes lexicographic listing chronological if
 *     the ID is sortable (ULID / time-based UUID).
 *   - manifest.json always sits at <runId>/manifest.json as the canonical
 *     pointer to the rest of the run's artifacts.
 *
 * Slugification: projectSlug + serviceName already come from columns that
 * are slug-shaped (lowercase alphanumeric + hyphens). We DO NOT re-slug
 * here — passing through preserves whatever the user picked. Path
 * traversal is defended by the strict regex in the destination validator.
 */

export interface KeyParts {
  /** Optional bucket-level prefix from the destination config. */
  pathPrefix?: string | null;
  projectSlug: string;
  serviceName: string;
  runId: string;
}

/** Reject any segment that contains a traversal token. We deliberately
 *  refuse `..`, leading `/`, embedded null bytes, and Windows drive-style
 *  prefixes — even though projectSlug/serviceName come from columns that
 *  validate at write time, defense-in-depth costs nothing and keeps an
 *  attacker from poking a destination key like `openship/../../../etc/`
 *  through the artifactName argument. */
function assertSafeSegment(segment: string, originalParts: ReadonlyArray<string | null | undefined>): void {
  if (segment.includes("\0")) {
    throw new Error("Key segment contains a null byte");
  }
  // After we strip leading/trailing slashes, any embedded `..` between
  // slashes — or a bare `..` — is a traversal attempt.
  const subSegments = segment.split("/");
  for (const sub of subSegments) {
    if (sub === ".." || sub === ".") {
      throw new Error(`Key segment "${sub}" is not allowed (parts: ${originalParts.join(", ")})`);
    }
  }
}

function joinKey(parts: Array<string | null | undefined>): string {
  const cleaned = parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ""));

  for (const segment of cleaned) {
    assertSafeSegment(segment, parts);
  }
  return cleaned.join("/");
}

/** Run-scoped directory key (the parent prefix for all artifacts in a run). */
export function runPrefix(parts: KeyParts): string {
  return joinKey([
    parts.pathPrefix,
    "openship",
    parts.projectSlug,
    parts.serviceName,
    parts.runId,
  ]);
}

export function artifactKey(parts: KeyParts, artifactName: string): string {
  return joinKey([runPrefix(parts), artifactName]);
}

export function manifestKey(parts: KeyParts): string {
  return artifactKey(parts, "manifest.json");
}
