"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Cloud,
  HardDrive,
  Server,
  Loader2,
} from "lucide-react";
import {
  backupDestinationsApi,
  type BackupDestinationSummary,
  getApiErrorMessage,
} from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { CreateDestinationModal } from "./_components/CreateDestinationModal";

const KIND_LABELS: Record<BackupDestinationSummary["kind"], string> = {
  s3_compatible: "S3-compatible",
  sftp: "SFTP",
  openship_server: "Existing server",
  local: "Local disk",
  http_upload: "HTTP upload",
};

const KIND_ICONS: Record<
  BackupDestinationSummary["kind"],
  React.ComponentType<{ className?: string }>
> = {
  s3_compatible: Cloud,
  sftp: Server,
  openship_server: Server,
  local: HardDrive,
  http_upload: Cloud,
};

export default function BackupsPage() {
  const [items, setItems] = useState<BackupDestinationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await backupDestinationsApi.list();
      setItems(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handlePreflight = useCallback(
    async (id: string) => {
      try {
        const res = await backupDestinationsApi.preflight(id);
        if (!res.data.ok) {
          window.alert(`Verification failed: ${res.data.reason}`);
        }
      } catch (err) {
        window.alert(getApiErrorMessage(err, "Preflight failed"));
      } finally {
        void load();
      }
    },
    [load],
  );

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      if (
        !window.confirm(
          `Delete destination "${name}"? Active backup policies will block this.`,
        )
      ) {
        return;
      }
      try {
        await backupDestinationsApi.delete(id);
        await load();
      } catch (err) {
        window.alert(getApiErrorMessage(err, "Delete failed"));
      }
    },
    [load],
  );

  return (
    <PageContainer>
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            Backups
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            External storage targets for project and service backups
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            Add Destination
          </button>
        )}
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState onAdd={() => setModalOpen(true)} />
      ) : (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <ul className="divide-y divide-border/50">
            {items.map((row) => {
              const Icon = KIND_ICONS[row.kind] ?? Cloud;
              return (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-4 px-6 py-4 transition-colors hover:bg-foreground/[0.02]"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05] border border-border/40">
                      <Icon className="size-4 text-foreground/70" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {row.name}
                        </p>
                        <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {KIND_LABELS[row.kind]}
                        </span>
                        {row.lastVerifiedAt ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                            title={`Last verified ${new Date(row.lastVerifiedAt).toLocaleString()}`}
                          >
                            <CheckCircle2 className="size-3" />
                            Verified
                          </span>
                        ) : row.lastVerifyError ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
                            title={row.lastVerifyError}
                          >
                            <AlertCircle className="size-3" />
                            Failed
                          </span>
                        ) : (
                          <span className="rounded-full bg-foreground/[0.04] px-2 py-0.5 text-[11px] font-medium text-muted-foreground/70">
                            Not verified
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                        {describeDestination(row)}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => handlePreflight(row.id)}
                      className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                      title="Test connection"
                    >
                      <RefreshCw className="size-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(row.id, row.name)}
                      className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                      title="Delete"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <CreateDestinationModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={async () => {
          setModalOpen(false);
          await load();
        }}
      />
    </PageContainer>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="py-16 text-center">
      {/* SVG illustration — backup-themed: stacked databases being archived to a cloud */}
      <div className="relative mx-auto w-64 h-44 mb-8">
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 260 180"
          fill="none"
        >
          {/* Stacked database cylinders (the source) — three layers, like archive depth */}
          {/* Bottom cylinder */}
          <path
            d="M40 122v12c0 5.5 12.5 10 28 10s28-4.5 28-10v-12"
            fill="var(--th-sf-04)"
            stroke="var(--th-bd-subtle)"
            strokeWidth="1"
          />
          <ellipse
            cx="68"
            cy="122"
            rx="28"
            ry="6"
            fill="var(--th-sf-05)"
            stroke="var(--th-bd-subtle)"
            strokeWidth="1"
          />

          {/* Middle cylinder */}
          <path
            d="M40 96v18c0 5.5 12.5 10 28 10s28-4.5 28-10V96"
            fill="var(--th-sf-03)"
            stroke="var(--th-bd-default)"
            strokeWidth="1"
          />
          <ellipse
            cx="68"
            cy="96"
            rx="28"
            ry="6"
            fill="var(--th-sf-05)"
            stroke="var(--th-bd-default)"
            strokeWidth="1"
          />

          {/* Top cylinder */}
          <path
            d="M40 70v18c0 5.5 12.5 10 28 10s28-4.5 28-10V70"
            fill="var(--th-card-bg)"
            stroke="var(--th-bd-default)"
            strokeWidth="1"
          />
          <ellipse
            cx="68"
            cy="70"
            rx="28"
            ry="6"
            fill="var(--th-card-bg)"
            stroke="var(--th-bd-default)"
            strokeWidth="1"
          />

          {/* Activity indicator dots on the top cylinder — colored like traffic lights */}
          <circle cx="55" cy="70" r="2.5" fill="#22c55e" fillOpacity="0.7" />
          <circle cx="63" cy="70" r="2.5" fill="#eab308" fillOpacity="0.5" />
          <circle cx="71" cy="70" r="2.5" fill="var(--th-on-12)" />

          {/* Arrow from databases to cloud — animated-looking dashed flow */}
          <path
            d="M105 95 Q 130 80 155 88"
            stroke="var(--th-on-20)"
            strokeWidth="2"
            strokeDasharray="4 4"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M150 84 L 156 88 L 152 94"
            stroke="var(--th-on-30)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />

          {/* Destination cloud (the backup target) */}
          <path
            d="M175 82
               c -6 0 -11 4 -12 9
               c -5 0 -9 4 -9 9
               c 0 5 4 9 9 9
               h 44
               c 6 0 11 -4 11 -10
               c 0 -5 -4 -10 -10 -10
               c -1 -6 -7 -11 -14 -11
               c -8 0 -15 5 -19 4z"
            fill="var(--th-card-bg)"
            stroke="var(--th-bd-default)"
            strokeWidth="1.5"
          />

          {/* Checkmark inside the cloud — backup verified */}
          <path
            d="M188 100 l 4 4 l 9 -9"
            stroke="#22c55e"
            strokeOpacity="0.8"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />

          {/* Decorative dots — same vocabulary as other empty states */}
          <circle cx="25" cy="55" r="4" fill="var(--th-on-10)" />
          <circle cx="35" cy="155" r="6" fill="var(--th-on-08)" />
          <circle cx="240" cy="50" r="3" fill="var(--th-on-12)" />
          <circle cx="245" cy="138" r="5" fill="var(--th-on-06)" />

          {/* Sparkle accents */}
          <path d="M15 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M230 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
        </svg>
      </div>

      <h3
        className="text-2xl font-medium text-foreground/80 mb-2"
        style={{ letterSpacing: "-0.2px" }}
      >
        No backup destinations yet
      </h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm mx-auto mb-8 leading-relaxed">
        Connect an S3-compatible bucket, an SFTP host, an existing openship
        server, or a local disk — services will then be able to back up to it.
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <Plus className="size-4" />
          Add Your First Destination
        </button>
      </div>

      {/* Feature highlight cards — exact home empty-state pattern */}
      <div className="max-w-2xl mx-auto">
        <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
          Supported destinations
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KindCard icon={Cloud} label="S3-compatible" sub="AWS · R2 · B2 · MinIO" />
          <KindCard icon={Server} label="SFTP" sub="Any SSH host" />
          <KindCard icon={Server} label="Existing server" sub="Reuse SSH creds" />
          <KindCard icon={HardDrive} label="Local disk" sub="Self-hosted only" />
        </div>
      </div>
    </div>
  );
}

function KindCard({
  icon: Icon,
  label,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub: string;
}) {
  return (
    <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </div>
  );
}

function describeDestination(row: BackupDestinationSummary): string {
  switch (row.kind) {
    case "s3_compatible":
      return `${row.bucket ?? "?"}${row.region ? ` · ${row.region}` : ""}${row.endpoint ? ` · ${row.endpoint}` : ""}`;
    case "sftp":
      return `${row.sshUser ?? "?"}@${row.sshHost ?? "?"}:${row.sshPort ?? 22}${row.pathPrefix ? `:${row.pathPrefix}` : ""}`;
    case "openship_server":
      return `server ${row.serverId?.slice(0, 8) ?? "?"}…${row.pathPrefix ? ` · ${row.pathPrefix}` : ""}`;
    case "local":
      return row.endpoint ?? "?";
    case "http_upload":
      return row.endpoint ?? "?";
  }
}
