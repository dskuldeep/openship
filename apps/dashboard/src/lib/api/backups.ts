/**
 * Backup + backup-destination API client. Mirrors the orchestrator's
 * shape: destinations are per-user, policies + runs scoped under a
 * project.
 */

import { api } from "./client";
import { endpoints } from "./endpoints";

// ─── Destination shapes (matches SerializedDestination from apps/api) ────────

export interface BackupDestinationSummary {
  id: string;
  name: string;
  kind: "s3_compatible" | "sftp" | "openship_server" | "local" | "http_upload";
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  pathPrefix: string | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  serverId: string | null;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSftpPassword: boolean;
  hasSftpPrivateKey: boolean;
  hasSftpKeyPassphrase: boolean;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDestinationInput {
  name: string;
  kind: BackupDestinationSummary["kind"];
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  pathPrefix?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  serverId?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sftpPassword?: string | null;
  sftpPrivateKey?: string | null;
  sftpKeyPassphrase?: string | null;
  isDefault?: boolean;
}

export type UpdateDestinationInput = Partial<CreateDestinationInput>;

// ─── Policy + run shapes ─────────────────────────────────────────────────────

export interface BackupPolicy {
  id: string;
  projectId: string;
  serviceId: string | null;
  destinationId: string;
  enabled: boolean;
  cronExpression: string | null;
  triggerOnPreDeploy: boolean;
  webhookToken: string | null;
  webhookLastFiredAt: string | null;
  retainCount: number | null;
  retainDays: number | null;
  payloadKind: string;
  payloadConfig: Record<string, unknown>;
  preHook: string | null;
  postHook: string | null;
  hookTimeoutSeconds: number;
  compressionAlgo: string;
  encryptionAtRest: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRestore {
  id: string;
  runId: string;
  destinationId: string;
  projectId: string | null;
  serviceId: string | null;
  userId: string;
  status:
    | "queued"
    | "preparing"
    | "prepared"
    | "applying"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "server_error";
  mode: "in_place" | "to_fork";
  forkMailServerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  bytesRestored: number | null;
  errorMessage: string | null;
  confirmationToken: string | null;
}

export interface BackupRun {
  id: string;
  policyId: string | null;
  destinationId: string | null;
  projectId: string | null;
  serviceId: string | null;
  userId: string;
  status:
    | "queued"
    | "preparing"
    | "snapshotting"
    | "uploading"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "server_error";
  triggeredBy: "manual" | "cron" | "webhook" | "pre_deploy";
  clientIp: string | null;
  startedAt: string;
  finishedAt: string | null;
  bytesTransferred: number | null;
  objectKeyPrefix: string | null;
  manifestKey: string | null;
  artifacts: unknown[];
  errorMessage: string | null;
}

// ─── API ─────────────────────────────────────────────────────────────────────

export const backupDestinationsApi = {
  list: () =>
    api.get<{ data: BackupDestinationSummary[] }>(endpoints.backupDestinations.list),
  get: (id: string) =>
    api.get<{ data: BackupDestinationSummary }>(endpoints.backupDestinations.get(id)),
  create: (body: CreateDestinationInput) =>
    api.post<{ data: BackupDestinationSummary }>(
      endpoints.backupDestinations.create,
      body,
    ),
  update: (id: string, body: UpdateDestinationInput) =>
    api.patch<{ data: BackupDestinationSummary }>(
      endpoints.backupDestinations.update(id),
      body,
    ),
  delete: (id: string) =>
    api.delete<{ data: { ok: true } }>(endpoints.backupDestinations.delete(id)),
  preflight: (id: string) =>
    api.post<{ data: { ok: boolean; reason?: string } }>(
      endpoints.backupDestinations.preflight(id),
    ),
};

export const backupsApi = {
  listPolicies: (projectId: string) =>
    api.get<{ data: BackupPolicy[] }>(endpoints.backups.listPolicies(projectId)),
  createPolicy: (
    projectId: string,
    body: {
      serviceId?: string | null;
      destinationId: string;
      cronExpression?: string;
      triggerOnPreDeploy?: boolean;
      retainCount?: number;
      retainDays?: number;
      payloadKind?: string;
      payloadConfig?: Record<string, unknown>;
      preHook?: string;
      postHook?: string;
      enabled?: boolean;
    },
  ) =>
    api.post<{ data: BackupPolicy }>(endpoints.backups.createPolicy(projectId), body),
  updatePolicy: (policyId: string, patch: Record<string, unknown>) =>
    api.patch<{ data: BackupPolicy }>(endpoints.backups.updatePolicy(policyId), patch),
  deletePolicy: (policyId: string) =>
    api.delete<{ data: { ok: true } }>(endpoints.backups.deletePolicy(policyId)),
  runNow: (policyId: string) =>
    api.post<{ data: { runId: string } }>(endpoints.backups.runNow(policyId)),
  listRuns: (projectId: string, opts?: { limit?: number; serviceId?: string }) =>
    api.get<{ data: BackupRun[] }>(endpoints.backups.listRuns(projectId), {
      params: opts,
    }),
  getRun: (runId: string) =>
    api.get<{ data: BackupRun }>(endpoints.backups.getRun(runId)),

  protectRun: (
    runId: string,
    body: { until?: string; protected?: boolean } = {},
  ) =>
    api.post<{ data: { ok: true; retentionLockedUntil: string | null } }>(
      endpoints.backups.protectRun(runId),
      body,
    ),

  // ── Restore ───────────────────────────────────────────────────────────────

  prepareRestore: (
    runId: string,
    opts?: { mode?: "in_place" | "to_fork"; forkMailServerId?: string | null },
  ) =>
    api.post<{ data: { restoreId: string; confirmationToken: string } }>(
      endpoints.backups.prepareRestore(runId),
      opts ?? {},
    ),

  applyRestore: (restoreId: string, confirmationToken: string) =>
    api.post<{ data: { ok: true } }>(
      endpoints.backups.applyRestore(restoreId),
      { confirmationToken },
    ),

  cancelRestore: (restoreId: string) =>
    api.post<{ data: { ok: true } }>(endpoints.backups.cancelRestore(restoreId)),

  getRestore: (restoreId: string) =>
    api.get<{ data: BackupRestore }>(endpoints.backups.getRestore(restoreId)),
};
