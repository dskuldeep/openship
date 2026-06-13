/**
 * Build and validate backup manifest.json — the canonical pointer to
 * a run's artifacts on the destination.
 *
 * The manifest is the LAST artifact a backup writes. A run is only
 * considered "complete" if its manifest.json exists at the destination.
 * Partial-upload visibility is handled at the artifact level by atomic
 * upload semantics in each destination adapter; this file is just the
 * top-level marker.
 */

import type { BackupManifest } from "../types";

export function buildManifest(opts: {
  runId: string;
  projectId: string;
  projectSlug: string;
  serviceId: string;
  serviceName: string;
  serviceImage: string | null;
  capturedAt: Date;
  artifacts: BackupManifest["artifacts"];
  envVarKeys: string[];
  serviceConfig: BackupManifest["serviceConfig"];
}): BackupManifest {
  return {
    version: 1,
    runId: opts.runId,
    projectId: opts.projectId,
    projectSlug: opts.projectSlug,
    serviceId: opts.serviceId,
    serviceName: opts.serviceName,
    serviceImage: opts.serviceImage,
    capturedAt: opts.capturedAt.toISOString(),
    artifacts: opts.artifacts,
    envVarKeys: opts.envVarKeys,
    serviceConfig: opts.serviceConfig,
  };
}

/** Throws on a parsed JSON that doesn't match the v1 manifest shape. */
export function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid manifest: not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1) {
    throw new Error(`Unsupported manifest version: ${String(v.version)}`);
  }
  for (const field of ["runId", "projectId", "serviceId", "capturedAt"]) {
    if (typeof v[field] !== "string") {
      throw new Error(`Invalid manifest: missing or non-string ${field}`);
    }
  }
  if (!Array.isArray(v.artifacts)) {
    throw new Error("Invalid manifest: artifacts is not an array");
  }
  return value as BackupManifest;
}
