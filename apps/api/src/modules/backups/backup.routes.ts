/**
 * Backup HTTP routes — mounted at /api by app.ts.
 *
 * Policy + run paths are scoped under projects to match the existing
 * dashboard URL structure. Webhook + scheduled triggers land in Chunk 2.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import * as ctrl from "./backup.controller";

export const backupRoutes = new Hono();

// ⚠ This sub-app is mounted at `/api` (app.ts:62). Using `.use("*", …)`
// here would apply authMiddleware to EVERY /api/* request in Hono v4 —
// including unrelated sibling sub-apps mounted at /api/cloud, etc. —
// which would 401 the cloud `exchange-code` endpoint among others.
// Scope the auth middleware to the actual backup paths instead.
backupRoutes.use("/projects/*", authMiddleware);
backupRoutes.use("/backup-policies/*", authMiddleware);
backupRoutes.use("/backup-runs/*", authMiddleware);
backupRoutes.use("/backup-restores/*", authMiddleware);

// Policies
backupRoutes.get("/projects/:projectId/backup-policies", ctrl.listProjectPolicies);
backupRoutes.post("/projects/:projectId/backup-policies", ctrl.createProjectPolicy);
backupRoutes.patch("/backup-policies/:policyId", ctrl.patchPolicy);
backupRoutes.delete("/backup-policies/:policyId", ctrl.removePolicy);

// Manual trigger
backupRoutes.post("/backup-policies/:policyId/run", ctrl.triggerManual);

// Runs
backupRoutes.get("/projects/:projectId/backup-runs", ctrl.listRuns);
backupRoutes.get("/backup-runs/:runId", ctrl.getOneRun);
backupRoutes.get("/backup-runs/:runId/stream", ctrl.streamRun);

// Protect-from-retention
backupRoutes.post("/backup-runs/:runId/protect", ctrl.protectRun);

// Restore
backupRoutes.post("/backup-runs/:runId/restore/prepare", ctrl.prepareRestore);
backupRoutes.post("/backup-restores/:restoreId/apply", ctrl.applyRestore);
backupRoutes.post("/backup-restores/:restoreId/cancel", ctrl.cancelRestore);
backupRoutes.get("/backup-restores/:restoreId", ctrl.getOneRestore);
backupRoutes.get("/backup-restores/:restoreId/stream", ctrl.streamRestore);
