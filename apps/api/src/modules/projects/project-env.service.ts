/**
 * Project environment variables service - list & set encrypted env vars.
 */

import { repos } from "@repo/db";
import { ValidationError, SYSTEM } from "@repo/core";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { TSetEnvVarsBody, TMergeEnvVarsBody } from "./project.schema";

// ─── List env vars ───────────────────────────────────────────────────────────

export async function listEnvVars(
  projectId: string,
  organizationId: string,
  environment?: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const vars = await repos.project.listEnvVars(projectId, environment);

  return vars.map((v) => {
    let plainValue: string;
    try {
      plainValue = decrypt(v.value);
    } catch {
      plainValue = v.value;
    }
    return {
      id: v.id,
      key: v.key,
      value: v.isSecret ? "••••••••" : plainValue,
      environment: v.environment,
      isSecret: v.isSecret,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
}

// ─── Set env vars ────────────────────────────────────────────────────────────

export async function setEnvVars(
  projectId: string,
  organizationId: string,
  data: TSetEnvVarsBody,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const keys = data.vars.map((v) => v.key);
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new ValidationError("Duplicate environment variable keys");
  }

  if (data.vars.length > SYSTEM.ENV_VARS.MAX_PER_PROJECT) {
    throw new ValidationError(
      `Maximum ${SYSTEM.ENV_VARS.MAX_PER_PROJECT} variables per project`,
    );
  }

  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted);
  return { count: data.vars.length };
}

// ─── Merge env vars (partial — safe for masked secrets) ──────────────────────

/**
 * Apply a partial diff to a project's env vars: `upserts` are added/updated,
 * `deletes` are removed, everything else is left untouched. Used by the
 * per-variable editor so a secret the user didn't change (shown masked in the
 * UI) is never re-sent and never corrupted — only the keys it names are touched.
 */
export async function mergeEnvVars(
  projectId: string,
  organizationId: string,
  data: TMergeEnvVarsBody,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // No key may appear in both upserts and deletes (ambiguous intent).
  const upsertKeys = data.upserts.map((v) => v.key);
  const dupInUpserts = new Set(upsertKeys);
  if (dupInUpserts.size !== upsertKeys.length) {
    throw new ValidationError("Duplicate environment variable keys in upserts");
  }
  const deleteSet = new Set(data.deletes);
  for (const key of upsertKeys) {
    if (deleteSet.has(key)) {
      throw new ValidationError(`Key "${key}" cannot be both upserted and deleted`);
    }
  }

  if (data.upserts.length > SYSTEM.ENV_VARS.MAX_PER_PROJECT) {
    throw new ValidationError(
      `Maximum ${SYSTEM.ENV_VARS.MAX_PER_PROJECT} variables per project`,
    );
  }

  const encrypted = data.upserts.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.mergeEnvVars(projectId, data.environment, encrypted, data.deletes);
  return { upserted: data.upserts.length, deleted: data.deletes.length };
}


