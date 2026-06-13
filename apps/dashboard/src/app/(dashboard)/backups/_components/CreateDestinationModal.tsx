"use client";

import React, { useEffect, useState } from "react";
import { ArrowLeft, Cloud, Server, HardDrive, Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  backupDestinationsApi,
  systemApi,
  type BackupDestinationSummary,
  type CreateDestinationInput,
  getApiErrorMessage,
} from "@/lib/api";

type Kind = Exclude<BackupDestinationSummary["kind"], "http_upload">;

interface KindOption {
  kind: Kind;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  examples: string;
}

const KIND_OPTIONS: KindOption[] = [
  {
    kind: "s3_compatible",
    title: "S3-compatible",
    description: "Any S3-API storage — AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO.",
    icon: Cloud,
    examples: "Most popular · works anywhere",
  },
  {
    kind: "sftp",
    title: "SFTP",
    description: "Push backups over SSH to an arbitrary host with new credentials.",
    icon: Server,
    examples: "Dedicated backup box · NAS",
  },
  {
    kind: "openship_server",
    title: "Existing server",
    description: "Reuse SSH credentials from a server you've already added to Openship.",
    icon: Server,
    examples: "Reuses /servers credentials",
  },
  {
    kind: "local",
    title: "Local disk",
    description: "Write to a directory on the API host. Disabled in cloud mode.",
    icon: HardDrive,
    examples: "Self-hosted only",
  },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

type Step = "pick" | "configure";

export function CreateDestinationModal({ isOpen, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [selectedKind, setSelectedKind] = useState<Kind | null>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setStep("pick");
      setSelectedKind(null);
    }
  }, [isOpen]);

  const selectedOption = selectedKind
    ? KIND_OPTIONS.find((o) => o.kind === selectedKind) ?? null
    : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth={step === "pick" ? "880px" : "760px"}
      width="100%"
      maxHeight="92vh"
    >
      <div className="flex max-h-[92vh] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-5">
          <div className="flex items-center gap-3 min-w-0">
            {step === "configure" && (
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label="Back to kind picker"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground truncate">
                {step === "pick"
                  ? "Add backup destination"
                  : `New ${selectedOption?.title ?? "destination"}`}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground truncate">
                {step === "pick"
                  ? "Pick where your backups will be stored."
                  : "Credentials are encrypted at rest and never displayed back."}
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Lock className="size-3.5" />
            Encrypted at rest
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8 sm:py-8">
          {step === "pick" ? (
            <KindPicker
              onPick={(kind) => {
                setSelectedKind(kind);
                setStep("configure");
              }}
            />
          ) : selectedKind ? (
            <ConfigureForm
              kind={selectedKind}
              onCancel={onClose}
              onCreated={onCreated}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// ─── Kind picker (step 1) ────────────────────────────────────────────────────

function KindPicker({ onPick }: { onPick: (kind: Kind) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {KIND_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.kind}
            type="button"
            onClick={() => onPick(opt.kind)}
            className="group flex items-start gap-4 rounded-2xl border border-border/50 bg-card p-5 text-left transition-all hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted border border-border/40 transition-colors group-hover:bg-primary/10 group-hover:border-primary/30">
              <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-foreground">
                {opt.title}
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {opt.description}
              </p>
              <p className="mt-3 text-xs text-muted-foreground/70 uppercase tracking-wider font-medium">
                {opt.examples}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Configure form (step 2) ─────────────────────────────────────────────────

function ConfigureForm({
  kind,
  onCancel,
  onCreated,
}: {
  kind: Kind;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [bucket, setBucket] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState<number | "">(22);
  const [sshUser, setSshUser] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPrivateKey, setSftpPrivateKey] = useState("");
  const [serverId, setServerId] = useState("");
  const [servers, setServers] = useState<
    Array<{ id: string; name?: string | null; sshHost: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "openship_server") return;
    void systemApi
      .listServers()
      .then((rows) => {
        setServers(
          rows as unknown as Array<{
            id: string;
            name?: string | null;
            sshHost: string;
          }>,
        );
      })
      .catch(() => setServers([]));
  }, [kind]);

  const submit = async () => {
    setError(null);
    const input: CreateDestinationInput = {
      name: name.trim(),
      kind,
    };
    if (kind === "s3_compatible") {
      input.endpoint = endpoint.trim() || null;
      input.region = region.trim() || null;
      input.bucket = bucket.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      input.accessKeyId = accessKeyId;
      input.secretAccessKey = secretAccessKey;
    } else if (kind === "sftp") {
      input.sshHost = sshHost.trim();
      input.sshPort = typeof sshPort === "number" ? sshPort : 22;
      input.sshUser = sshUser.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      if (sftpPassword) input.sftpPassword = sftpPassword;
      if (sftpPrivateKey) input.sftpPrivateKey = sftpPrivateKey;
    } else if (kind === "openship_server") {
      input.serverId = serverId;
      input.pathPrefix = pathPrefix.trim() || null;
    } else if (kind === "local") {
      input.endpoint = endpoint.trim();
    }

    setBusy(true);
    try {
      await backupDestinationsApi.create(input);
      await onCreated();
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to create destination"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production R2"
          className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
        />
      </Field>

      {kind === "s3_compatible" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="Endpoint"
            hint="Empty = AWS S3. R2: https://<account>.r2.cloudflarestorage.com"
          >
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://…"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Region">
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1 / auto"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Bucket">
            <input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="my-backups"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Path prefix" hint="Optional subpath inside the bucket">
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="openship/prod"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Access key ID">
            <input
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Secret access key">
            <input
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              type="password"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "sftp" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Host">
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="backups.example.com"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              value={sshPort}
              onChange={(e) =>
                setSshPort(e.target.value === "" ? "" : Number(e.target.value))
              }
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="User">
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="backup"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Path prefix">
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label="Password" hint="Leave empty if using a private key">
            <input
              value={sftpPassword}
              onChange={(e) => setSftpPassword(e.target.value)}
              type="password"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field
            label="Private key (PEM)"
            hint="Used when password is empty"
          >
            <textarea
              value={sftpPrivateKey}
              onChange={(e) => setSftpPrivateKey(e.target.value)}
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "openship_server" && (
        <div className="grid grid-cols-1 gap-4">
          <Field
            label="Server"
            hint="Reuses SSH credentials already saved in /servers"
          >
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            >
              <option value="">— select a server —</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.sshHost} ({s.sshHost})
                </option>
              ))}
            </select>
            {servers.length === 0 && (
              <span className="block text-sm text-muted-foreground">
                No servers configured yet. Add one under{" "}
                <a href="/servers" className="text-primary hover:underline">
                  Servers
                </a>{" "}
                first.
              </span>
            )}
          </Field>
          <Field
            label="Remote path"
            hint="Absolute directory on the server (e.g. /backups/openship)"
          >
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "local" && (
        <Field
          label="Absolute path"
          hint="Filesystem path on the API host. Disabled in cloud mode."
        >
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="/var/backups/openship"
            className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
          />
        </Field>
      )}

      <div className="flex items-center justify-end gap-3 pt-6 border-t border-border/40 -mx-6 px-6 -mb-6 pb-6 sm:-mx-8 sm:px-8 sm:-mb-8 sm:pb-8 mt-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="h-11 inline-flex items-center justify-center rounded-xl px-5 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !name.trim()}
          className="h-11 inline-flex items-center gap-2 px-6 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
        >
          {busy ? "Saving…" : "Save destination"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground mb-1.5">
        {label}
      </span>
      {hint && (
        <span className="block text-xs text-muted-foreground mb-1.5">
          {hint}
        </span>
      )}
      {children}
    </label>
  );
}
