"use client";

import React, { useEffect, useState } from "react";
import { X, Copy, RefreshCw, Globe, Clock, Calendar } from "lucide-react";
import {
  backupsApi,
  backupDestinationsApi,
  getApiBaseUrl,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
} from "@/lib/api";

interface Props {
  projectId: string;
  serviceId?: string | null;
  serviceName?: string;
  existing?: BackupPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}

const CRON_PRESETS = [
  { label: "Hourly", value: "7 * * * *" },
  { label: "Daily (03:17)", value: "17 3 * * *" },
  { label: "Weekly (Sun 03:17)", value: "17 3 * * 0" },
  { label: "Monthly (1st 03:17)", value: "17 3 1 * *" },
  { label: "Manual only", value: "" },
];

export function PolicyEditor({
  projectId,
  serviceId,
  serviceName,
  existing,
  onClose,
  onSaved,
}: Props): React.JSX.Element {
  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [destinationId, setDestinationId] = useState(existing?.destinationId ?? "");
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [triggerOnPreDeploy, setTriggerOnPreDeploy] = useState(
    existing?.triggerOnPreDeploy ?? false,
  );
  const [enableWebhook, setEnableWebhook] = useState(!!existing?.webhookToken);
  const [retainCount, setRetainCount] = useState<number | "">(existing?.retainCount ?? 7);
  const [retainDays, setRetainDays] = useState<number | "">(existing?.retainDays ?? "");
  const [preHook, setPreHook] = useState(existing?.preHook ?? "");
  const [postHook, setPostHook] = useState(existing?.postHook ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void backupDestinationsApi.list().then((res) => {
      setDestinations(res.data);
      if (!existing && res.data.length > 0 && !destinationId) {
        setDestinationId(res.data[0].id);
      }
    });
  }, [existing, destinationId]);

  const webhookUrl = existing?.webhookToken
    ? `${getApiBaseUrl()}webhooks/backup/${existing.webhookToken}`
    : null;

  const submit = async () => {
    if (!destinationId) {
      window.alert("Select a destination");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        serviceId: serviceId ?? null,
        destinationId,
        cronExpression: cronExpression || undefined,
        triggerOnPreDeploy,
        enableWebhook,
        retainCount: retainCount === "" ? undefined : Number(retainCount),
        retainDays: retainDays === "" ? undefined : Number(retainDays),
        preHook: preHook.trim() || undefined,
        postHook: postHook.trim() || undefined,
        enabled,
      };
      if (existing) {
        await backupsApi.updatePolicy(existing.id, payload);
      } else {
        await backupsApi.createPolicy(projectId, payload);
      }
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, "Failed to save policy"));
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!existing) return;
    if (!window.confirm("Rotate webhook token? The current URL will stop working.")) return;
    setBusy(true);
    try {
      await backupsApi.updatePolicy(existing.id, { rotateWebhookToken: true });
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, "Failed to rotate token"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="relative max-h-[90vh] w-[600px] max-w-[95vw] overflow-y-auto rounded-2xl border border-border/50 bg-card p-6 shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-lg font-semibold text-foreground">
          {existing ? "Edit backup policy" : "Create backup policy"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {serviceName ? `Service: ${serviceName}` : "Project-level policy"}
        </p>

        <div className="mt-6 space-y-5">
          <Field label="Destination">
            <select
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm"
            >
              <option value="">— select —</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.kind})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Schedule">
            <div className="space-y-2">
              <div className="flex gap-2 flex-wrap">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setCronExpression(p.value)}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      cronExpression === p.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/50 hover:bg-muted"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="Custom cron (5 fields), or leave blank for manual-only"
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs"
              />
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Retain count" hint="Keep N most recent succeeded runs">
              <input
                type="number"
                value={retainCount}
                onChange={(e) =>
                  setRetainCount(e.target.value === "" ? "" : Number(e.target.value))
                }
                min={1}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Retain days" hint="Drop runs older than N days">
              <input
                type="number"
                value={retainDays}
                onChange={(e) =>
                  setRetainDays(e.target.value === "" ? "" : Number(e.target.value))
                }
                min={1}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <Field
            label={
              <span className="flex items-center gap-2">
                <Calendar className="size-3.5" />
                Pre-deploy trigger
              </span>
            }
          >
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={triggerOnPreDeploy}
                onChange={(e) => setTriggerOnPreDeploy(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-foreground/80">
                Automatically back up before each new deployment lands
                <span className="block text-xs text-muted-foreground">
                  Fires on every successful build, just before the new code goes live.
                </span>
              </span>
            </label>
          </Field>

          <Field
            label={
              <span className="flex items-center gap-2">
                <Globe className="size-3.5" />
                Webhook trigger
              </span>
            }
          >
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={enableWebhook}
                onChange={(e) => setEnableWebhook(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-foreground/80">
                Enable inbound webhook URL
                <span className="block text-xs text-muted-foreground">
                  Generates a per-policy token. POST to the URL from any external
                  trigger (GitHub Actions, monitoring, your own scheduler).
                </span>
              </span>
            </label>
            {webhookUrl && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px]">
                <code className="flex-1 truncate">{webhookUrl}</code>
                <button
                  onClick={() => navigator.clipboard.writeText(webhookUrl)}
                  className="rounded p-1 hover:bg-background"
                  title="Copy URL"
                >
                  <Copy className="size-3" />
                </button>
                <button
                  onClick={rotateToken}
                  className="rounded p-1 hover:bg-background"
                  title="Rotate token"
                >
                  <RefreshCw className="size-3" />
                </button>
              </div>
            )}
          </Field>

          <Field
            label={
              <span className="flex items-center gap-2">
                <Clock className="size-3.5" />
                Pre-hook (runs before snapshot)
              </span>
            }
            hint="Common for DBs: pg_dump > /tmp/dump.sql. Failure aborts the run."
          >
            <textarea
              value={preHook}
              onChange={(e) => setPreHook(e.target.value)}
              rows={2}
              placeholder="pg_dump -Fc -U $POSTGRES_USER $POSTGRES_DB > /tmp/dump.dump"
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs"
            />
          </Field>

          <Field label="Post-hook (runs after upload)" hint="Cleanup; failures logged but don't fail the run.">
            <textarea
              value={postHook}
              onChange={(e) => setPostHook(e.target.value)}
              rows={2}
              placeholder="rm -f /tmp/dump.dump"
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs"
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Policy enabled
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !destinationId}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "Saving…" : existing ? "Save changes" : "Create policy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground/80">{label}</label>
      {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
