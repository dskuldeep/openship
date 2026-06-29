/**
 * Pure diff computation for the per-variable env editor. Kept framework-free so
 * the data-loss-critical logic (never re-send an untouched masked secret; only
 * touch keys the user actually changed/added/removed) is unit-testable.
 */

export interface EnvEditorRow {
  /** Current key (callers pass it already trimmed). */
  key: string;
  /** Current input value. "" for an untouched secret (we never hold the real value). */
  value: string;
  isSecret: boolean;
  /** The persisted key when loaded (null for a freshly-added row). */
  originalKey: string | null;
  /** Was this loaded as a secret whose real value we don't have until re-entered? */
  loadedSecret: boolean;
}

export interface EnvDiff {
  upserts: { key: string; value: string; isSecret: boolean }[];
  deletes: string[];
}

export type EnvDiffResult = { ok: true; diff: EnvDiff } | { ok: false; error: string };

/**
 * Compute the merge diff (upserts + deletes) from the editor's CURRENT rows and
 * the set of keys that existed when the editor loaded (`originalKeys`). The
 * original set is required because a deleted var is removed from `rows`
 * entirely — without it we could never tell a deletion from "never existed".
 *
 * Returns a validation error instead of a diff when the intent can't be
 * satisfied safely (e.g. renaming a masked secret without re-entering its
 * value — we don't have the value to carry over).
 */
export function computeEnvDiff(rows: EnvEditorRow[], originalKeys: string[]): EnvDiffResult {
  const seen = new Set<string>();
  const upserts: EnvDiff["upserts"] = [];

  for (const r of rows) {
    // Ignore a completely blank freshly-added row.
    if (!r.key && !r.value && r.originalKey === null) continue;

    if (!r.key) return { ok: false, error: "Every variable needs a name" };
    if (seen.has(r.key)) return { ok: false, error: `Duplicate key "${r.key}"` };
    seen.add(r.key);

    const renamed = r.originalKey !== null && r.key !== r.originalKey;
    const userEnteredValue = r.value !== "";

    if (r.originalKey === null) {
      // New var — must carry a value.
      if (!userEnteredValue) return { ok: false, error: `"${r.key}" needs a value` };
      upserts.push({ key: r.key, value: r.value, isSecret: r.isSecret });
      continue;
    }

    if (r.loadedSecret && !userEnteredValue) {
      // Untouched masked secret: we don't have its value. Renaming or flipping
      // its secret flag would lose the value, so require a re-entry; otherwise
      // leave it entirely alone (not in the diff).
      if (renamed || r.isSecret !== true) {
        return { ok: false, error: `Re-enter the value for "${r.originalKey}" to change it` };
      }
      continue;
    }

    if (renamed || userEnteredValue) {
      upserts.push({ key: r.key, value: r.value, isSecret: r.isSecret });
    }
  }

  // Deletes: any key that existed at load but is no longer present under its
  // OWN name now — covers BOTH removed rows (absent from `rows`) and the old
  // name of a renamed row. Computed against `originalKeys`, not `rows`, so a
  // deleted row (which is gone from `rows`) is still caught.
  const keptOriginalKeys = new Set(
    rows
      .filter((r) => r.originalKey !== null && r.key === r.originalKey)
      .map((r) => r.originalKey as string),
  );
  const upsertKeys = new Set(upserts.map((u) => u.key));
  const deletes = Array.from(new Set(originalKeys))
    .filter((k) => !keptOriginalKeys.has(k))
    .filter((k) => !upsertKeys.has(k));

  return { ok: true, diff: { upserts, deletes } };
}
