"use client";

/**
 * Backup tab — backs up the mail server through openship's GENERAL backup
 * system (same policy → orchestrator → destination pipeline as service
 * backups). The mail server is just a new backup SOURCE; destinations
 * ("download on my server" = an openship_server destination) are managed
 * on the shared /backups page and reused here.
 *
 * The include-checkboxes map to the policy's payloadConfig:
 *   - Accounts, domains & aliases   (always — the vmail dump)
 *   - Mailbox message data          (the /var/vmail maildirs; large)
 *   - DKIM keys & secrets           (DKIM + config + mail-state.json)
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  DatabaseBackup,
  HardDrive,
  Loader2,
  Play,
  Save,
  ShieldAlert,
  Check,
  CircleX,
  Clock,
  ArrowRight,
} from "lucide-react";
import {
  mailAdminApi,
  backupDestinationsApi,
  backupsApi,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupRun,
  type MailBackupPolicy,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { SectionCard } from "./_shared/section-card";
import { MailRestoreModal } from "./mail-restore-modal";

const SCHEDULES: Array<{ label: string; value: string | null }> = [
  { label: "Manual only", value: null },
  { label: "Daily", value: "17 3 * * *" },
  { label: "Weekly", value: "17 3 * * 0" },
];

export function BackupTab({ serverId, domain }: { serverId: string; domain: string }) {
  const { showToast } = useToast();
  const [restoreTarget, setRestoreTarget] = useState<{
    run: BackupRun;
    mode: "in_place" | "to_fork";
  } | null>(null);

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [policy, setPolicy] = useState<MailBackupPolicy | null>(null);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [destinationId, setDestinationId] = useState("");
  const [messageData, setMessageData] = useState(false);
  const [keys, setKeys] = useState(true);
  const [cron, setCron] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [destRes, polRes, runsRes] = await Promise.all([
        backupDestinationsApi.list().catch(() => ({ data: [] as BackupDestinationSummary[] })),
        mailAdminApi.backup.getPolicy(serverId).catch(() => ({ policy: null })),
        mailAdminApi.backup.listRuns(serverId).catch(() => ({ runs: [] as BackupRun[] })),
      ]);
      setDestinations(destRes.data);
      setRuns(runsRes.runs);
      const pol = polRes.policy;
      setPolicy(pol);
      if (pol) {
        setDestinationId(pol.destinationId);
        setMessageData(pol.payloadConfig?.mail?.messageData === true);
        setKeys(pol.payloadConfig?.mail?.keys !== false);
        setCron(pol.cronExpression ?? null);
      } else if (destRes.data[0]) {
        setDestinationId(destRes.data[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<MailBackupPolicy | null> => {
    if (!destinationId) {
      showToast("Pick a backup destination first.", "error", "Backup");
      return null;
    }
    setSaving(true);
    try {
      const { policy: saved } = await mailAdminApi.backup.savePolicy(serverId, {
        destinationId,
        messageData,
        keys,
        cronExpression: cron,
      });
      setPolicy(saved);
      showToast("Backup settings saved.", "success", "Backup");
      return saved;
    } catch (err) {
      showToast(getApiErrorMessage(err, "Could not save backup settings"), "error", "Backup");
      return null;
    } finally {
      setSaving(false);
    }
  }, [serverId, destinationId, messageData, keys, cron, showToast]);

  const backupNow = useCallback(async () => {
    setRunning(true);
    try {
      // Persist the current selection first so the run reflects the checkboxes.
      const saved = policy ? await save() : await save();
      if (!saved) return;
      await backupsApi.runNow(saved.id);
      showToast("Backup started. It'll appear below as it runs.", "success", "Backup");
      // Give the run a moment to register, then refresh the list.
      setTimeout(() => {
        void mailAdminApi.backup
          .listRuns(serverId)
          .then((r) => setRuns(r.runs))
          .catch(() => {});
      }, 1200);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Could not start backup"), "error", "Backup");
    } finally {
      setRunning(false);
    }
  }, [policy, save, serverId, showToast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const noDestinations = destinations.length === 0;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Backup</h2>
        <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
          Snapshot this mail server to one of your backup destinations. To move a
          server, back it up here, set the target up with the install wizard, then
          restore this backup onto it.
        </p>
      </div>

      {/* What to include */}
      <SectionCard
        title="What to back up"
        description="Accounts and auth are always included; message data and keys are optional."
        icon={DatabaseBackup}
      >
        <div className="space-y-3">
          <CheckRow
            checked
            disabled
            onChange={() => {}}
            title="Accounts, domains & aliases"
            desc="Mailboxes (with password hashes), domains, and aliases — the vmail database."
          />
          <CheckRow
            checked={messageData}
            onChange={setMessageData}
            title="Mailbox message data"
            desc="Every stored email (the /var/vmail maildirs). Can be large."
          />
          <CheckRow
            checked={keys}
            onChange={setKeys}
            title="DKIM keys & secrets"
            desc="DKIM keys + config + mail-state.json. Keeps DKIM valid on restore — but the archive then holds private keys and secrets."
          />
          {keys && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3.5 py-2.5">
              <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                The backup will contain password hashes, DKIM private keys, and
                plaintext secrets. Keep the destination private.
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Destination + schedule */}
      <SectionCard
        title="Destination & schedule"
        description="Backups stream to a destination you manage on the Backups page."
        icon={HardDrive}
      >
        {noDestinations ? (
          <Link
            href="/backups"
            className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 hover:bg-muted/40 transition-colors"
          >
            <p className="text-sm text-muted-foreground">
              No backup destinations yet. Add one (e.g. an existing server) on the
              Backups page.
            </p>
            <ArrowRight className="size-4 text-muted-foreground/60 shrink-0" />
          </Link>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-sm font-medium text-foreground mb-1.5">Destination</span>
              <select
                value={destinationId}
                onChange={(e) => setDestinationId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-foreground mb-1.5">Automatic backups</span>
              <select
                value={cron ?? ""}
                onChange={(e) => setCron(e.target.value || null)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {SCHEDULES.map((s) => (
                  <option key={s.label} value={s.value ?? ""}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={save}
            disabled={saving || noDestinations || !destinationId}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save settings
          </button>
          <button
            onClick={backupNow}
            disabled={running || noDestinations || !destinationId}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Back up now
          </button>
        </div>
      </SectionCard>

      {/* Recent runs */}
      <SectionCard title="Recent backups" icon={Clock} density="split">
        {runs.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No backups yet.
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                onRestore={(mode) => setRestoreTarget({ run: r, mode })}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {restoreTarget && (
        <MailRestoreModal
          run={restoreTarget.run}
          mode={restoreTarget.mode}
          sourceServerId={serverId}
          domain={domain}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            void mailAdminApi.backup
              .listRuns(serverId)
              .then((r) => setRuns(r.runs))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function CheckRow({
  checked,
  disabled,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-xl border border-border/60 px-4 py-3 ${
        disabled ? "opacity-70" : "cursor-pointer hover:bg-muted/30"
      } transition-colors`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-primary"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </label>
  );
}

function RunRow({
  run,
  onRestore,
}: {
  run: BackupRun;
  onRestore: (mode: "in_place" | "to_fork") => void;
}) {
  const p = runPresentation(run.status);
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${p.bg}`}>
        <p.Icon className={`size-4 ${p.color} ${p.spin ? "animate-spin" : ""}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground capitalize">{run.status}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {new Date(run.startedAt).toLocaleString()}
          {run.errorMessage ? ` · ${run.errorMessage.slice(0, 80)}` : ""}
        </p>
      </div>
      {typeof run.bytesTransferred === "number" && run.bytesTransferred > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {formatBytes(run.bytesTransferred)}
        </span>
      )}
      {run.status === "succeeded" && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onRestore("in_place")}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Restore
          </button>
          <span className="text-muted-foreground/30">·</span>
          <button
            onClick={() => onRestore("to_fork")}
            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Migrate
          </button>
        </div>
      )}
    </div>
  );
}

function runPresentation(status: BackupRun["status"]) {
  if (status === "succeeded")
    return { Icon: Check, bg: "bg-emerald-500/10", color: "text-emerald-600 dark:text-emerald-400", spin: false };
  if (status === "failed" || status === "server_error" || status === "cancelled")
    return { Icon: CircleX, bg: "bg-red-500/10", color: "text-red-600 dark:text-red-400", spin: false };
  return { Icon: Loader2, bg: "bg-blue-500/10", color: "text-blue-600 dark:text-blue-400", spin: true };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
