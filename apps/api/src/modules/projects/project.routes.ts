/**
 * Project routes - mounted at /api/projects in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter
 * middleware (check + audit emission). The boot scanner refuses to
 * start if any route lacks one.
 */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./project.controller";
import * as transfer from "./transfer.controller";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects",
});

/* All project routes require authentication. The route-level
   `requirePermission` middleware (mounted automatically by secureRouter)
   loads each resource and validates org membership via the resource's
   own `organization_id` — no session-mutating auto-switch needed. */

/* ─── Local-only routes (hidden in cloud mode) ─────────────────────────── */
r.get("/local", { tag: "project:list" }, localOnly, ctrl.listLocal);
// Collection-scoped writes: org from request (X-Organization-Id or
// session default); no :id in the URL — the controller resolves the
// project from the JSON body. `collection: true` keeps the existing
// :id-required default safe for per-resource routes below.
r.post("/scan", { tag: "project:write", collection: true }, localOnly, ctrl.scanLocal);
r.post("/import", { tag: "project:write", collection: true }, localOnly, ctrl.importLocal);

/* ─── Top-level project operations ─────────────────────────────────────── */
r.get("/home", { tag: "project:list" }, ctrl.getHome);
r.post("/ensure", { tag: "project:write", collection: true }, ctrl.ensure);
r.get("/", { tag: "project:list" }, ctrl.list);
r.post("/", { tag: "project:write", collection: true }, ctrl.create);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
r.get("/:id", { tag: "project:read" }, ctrl.getById);
r.patch("/:id", { tag: "project:write" }, ctrl.update);
r.delete("/:id", { tag: "project:admin" }, ctrl.remove);
r.get("/:id/info", { tag: "project:read" }, ctrl.getInfo);
r.get("/:id/environments", { tag: "project:read" }, ctrl.listEnvironments);
r.post("/:id/environments", { tag: "project:write" }, ctrl.createEnvironment);
r.get("/:id/deletion-preview", { tag: "project:read" }, ctrl.deletionPreview);

/* ─── Build options ────────────────────────────────────────────────────── */
r.post("/:id/options", { tag: "project:write" }, ctrl.setOptions);

/* ─── Enable / Disable ─────────────────────────────────────────────────── */
r.post("/:id/enable", { tag: "project:write" }, ctrl.enable);
r.post("/:id/disable", { tag: "project:write" }, ctrl.disable);

/* ─── Environment variables ────────────────────────────────────────────── */
// Project-scoped bulk routes (no per-env_var id in the URL) → gate on the
// project, matching what the controllers already assert (permission.assert
// project:read/write) and how /:id/options works. The previous
// project:env_var:* tags required a :envVarId param these routes don't have,
// so the permission middleware 400'd before the handler. Secret VALUES stay
// protected by masking in listEnvVars, not by the route tag.
r.get("/:id/env", { tag: "project:read" }, ctrl.listEnvVars);
r.put("/:id/env", { tag: "project:write" }, ctrl.setEnvVars);
r.patch("/:id/env", { tag: "project:write" }, ctrl.mergeEnvVars);

/* ─── Per-project clone token (git credential override) ────────────────── */
r.get("/:id/clone-token", { tag: "project:read" }, ctrl.getCloneToken);
r.patch("/:id/clone-token", { tag: "project:admin" }, ctrl.updateCloneToken);

/* ─── Git ──────────────────────────────────────────────────────────────── */
r.get("/:id/git", { tag: "project:read" }, ctrl.getGitInfo);
r.get("/:id/commit-status", { tag: "project:read" }, ctrl.getCommitStatus);
r.post("/:id/git/link", { tag: "project:write" }, ctrl.linkRepo);
r.get("/:id/branches", { tag: "project:read" }, ctrl.listBranches);
r.post("/:id/auto-deploy", { tag: "project:write" }, ctrl.setAutoDeploy);
r.post("/:id/webhook-domain", { tag: "project:write" }, ctrl.setWebhookDomain);
r.post("/:id/branch", { tag: "project:write" }, ctrl.setBranch);

/* ─── Resources ────────────────────────────────────────────────────────── */
r.get("/:id/resources", { tag: "project:read" }, ctrl.getResources);
r.patch("/:id/resources", { tag: "project:write" }, ctrl.updateResources);
r.post("/:id/resources", { tag: "project:write" }, ctrl.updateResources);

/* ─── Sleep mode ───────────────────────────────────────────────────────── */
r.post("/:id/sleep-mode", { tag: "project:write" }, ctrl.setSleepMode);

/* ─── Deployments ──────────────────────────────────────────────────────── */
r.get("/:id/deployments", { tag: "project:deployment:list" }, ctrl.listDeployments);
r.post("/:id/deployment-session", { tag: "project:deployment:write" }, ctrl.deploymentSession);

/* ─── Custom domain ────────────────────────────────────────────────────── */
r.post("/:id/connect", { tag: "project:domain:write" }, ctrl.connectDomain);

/* ─── Runtime logs ─────────────────────────────────────────────────────── */
r.get("/:id/logs", { tag: "project:read" }, ctrl.runtimeLogs);
r.get("/:id/logs/stream", { tag: "project:read" }, ctrl.runtimeLogStream);

/* ─── Server HTTP request logs ─────────────────────────────────────────── */
r.get("/:id/server-logs/recent", { tag: "project:read" }, ctrl.recentServerLogs);
r.get("/:id/server-logs/stream-token", { tag: "project:read" }, ctrl.serverLogStreamToken);
r.get("/:id/server-logs/stream", { tag: "project:read" }, ctrl.serverLogStream);

/* ─── Project transfer (local <-> cloud) ───────────────────────────────── */
r.post("/:id/transfer/to-cloud", { tag: "project:admin" }, transfer.transferToCloud);
r.post("/:id/transfer/to-self-hosted", { tag: "project:admin" }, transfer.transferToSelfHosted);

export const projectRoutes = r.hono;
