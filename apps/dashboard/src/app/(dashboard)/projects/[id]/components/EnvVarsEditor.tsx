import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Loader2, Eye, EyeOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { computeEnvDiff } from "./env-diff";

/**
 * Per-variable production env editor (modal). Safe by design:
 *  - reads via GET /:id/env (secret VALUES come back masked);
 *  - saves a DIFF via PATCH /:id/env (merge) — only added/changed/deleted keys
 *    are touched. A secret the user didn't re-enter is never re-sent, so masked
 *    secrets can't be overwritten and untouched vars are never wiped.
 */

const ENVIRONMENT = "production";

interface Row {
  /** Stable local id for React keys. */
  uid: string;
  key: string;
  /** Current input value. For an untouched secret this stays "" (we never hold the real value). */
  value: string;
  isSecret: boolean;
  /** The persisted key when this row was loaded (null for a freshly-added row). */
  originalKey: string | null;
  /** Was this loaded as a secret whose real value we don't have until re-entered? */
  loadedSecret: boolean;
}

let uidCounter = 0;
const nextUid = () => `row-${uidCounter++}`;

export function EnvVarsEditor({
  projectId,
  isOpen,
  onClose,
}: {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  // Keys that existed when the editor loaded — needed to detect deletions
  // (a removed row is gone from `rows`, so its key must be remembered here).
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await projectsApi.getEnv(projectId);
      const loaded: Row[] = (res?.data ?? [])
        .filter((v) => v.environment === ENVIRONMENT)
        .map((v) => ({
          uid: nextUid(),
          key: v.key,
          value: v.isSecret ? "" : v.value, // never seed the input with the mask
          isSecret: v.isSecret,
          originalKey: v.key,
          loadedSecret: v.isSecret,
        }));
      setRows(loaded);
      setOriginalKeys(loaded.map((r) => r.key));
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to load environment variables"), "error", "Error");
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    if (isOpen) {
      setReveal({});
      void load();
    }
  }, [isOpen, load]);

  const update = (uid: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { uid: nextUid(), key: "", value: "", isSecret: false, originalKey: null, loadedSecret: false },
    ]);

  const removeRow = (uid: string) => setRows((prev) => prev.filter((r) => r.uid !== uid));

  const handleSave = async () => {
    const result = computeEnvDiff(rows.map((r) => ({ ...r, key: r.key.trim() })), originalKeys);
    if (!result.ok) {
      showToast(result.error, "error", "Validation");
      return;
    }
    const { upserts, deletes } = result.diff;

    if (upserts.length === 0 && deletes.length === 0) {
      onClose(); // nothing changed
      return;
    }

    setSaving(true);
    try {
      await projectsApi.mergeEnv(projectId, { environment: ENVIRONMENT, upserts, deletes });
      showToast("Environment variables saved", "success", "Saved");
      onClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to save environment variables"), "error", "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="640px"
      width="92vw"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save changes
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">Environment variables</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Production. Encrypted at rest. Secrets show as set — type to replace; leave blank to keep.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-6 text-center text-sm text-muted-foreground">
                No environment variables yet.
              </p>
            ) : (
              rows.map((r) => {
                const showValue = reveal[r.uid] || (!r.isSecret && !r.loadedSecret);
                return (
                  <div key={r.uid} className="flex items-center gap-2">
                    <input
                      value={r.key}
                      onChange={(e) => update(r.uid, { key: e.target.value })}
                      placeholder="KEY"
                      spellCheck={false}
                      className="h-9 w-2/5 rounded-lg border border-border/50 bg-muted/20 px-3 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary/40"
                    />
                    <div className="relative flex-1">
                      <input
                        type={showValue ? "text" : "password"}
                        value={r.value}
                        onChange={(e) => update(r.uid, { value: e.target.value })}
                        placeholder={r.loadedSecret ? "•••••••• (set — type to replace)" : "value"}
                        spellCheck={false}
                        className="h-9 w-full rounded-lg border border-border/50 bg-muted/20 px-3 pr-9 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary/40"
                      />
                      <button
                        type="button"
                        onClick={() => setReveal((p) => ({ ...p, [r.uid]: !p[r.uid] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showValue ? "Hide value" : "Show value"}
                      >
                        {showValue ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => update(r.uid, { isSecret: !r.isSecret })}
                      title={r.isSecret ? "Marked secret" : "Mark as secret"}
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        r.isSecret
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
                          : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <KeyRound className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(r.uid)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                      aria-label="Remove variable"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })
            )}

            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              <Plus className="size-3.5" />
              Add variable
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
