/**
 * Single entry point for (re)applying a project's LIVE routes on a mutation
 * (service edit/delete, single-app publicEndpoints edit, webhook-domain set).
 *
 * Every edit path funnels through here so the routing surface is chosen ONCE,
 * consistently, and the webhook-proxy + best-effort semantics live in one place
 * rather than being copy-pasted per caller:
 *   - cloud project      → the runtime's page/workspace primitives
 *                          (cloud-route.service; the CloudInfraProvider routing
 *                          stub is a no-op).
 *   - self-hosted target → the DEPLOYMENT'S OWN routing provider (the local box,
 *                          or a remote server/sandbox over SSH) resolved via
 *                          resolveDeploymentRuntime — never the global
 *                          platform() singleton, which only ever targets the
 *                          orchestrator's local openresty.
 *
 * Callers compute the targets (the upstream differs: a service uses its
 * container-row IP, a single-app uses the deployment container IP, the webhook
 * domain uses the primary service IP) and hand them here; the dispatch, the
 * webhook-proxy re-attach, and the error tolerance are shared.
 *
 * Best-effort: the DB row is already committed by the caller, so a routing
 * failure logs and defers to the next deploy rather than failing the request.
 */

import type { Deployment } from "@repo/db";
import type { Platform } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { platform } from "./controller-helpers";
import { resolveDeploymentRuntime } from "./deployment-runtime";
import {
  reapplyCloudProjectRoute,
  removeCloudProjectRoute,
  type CloudRouteProject,
} from "./cloud-route.service";
import { webhookProxyTarget } from "../config";

export interface RouteReconcileProject extends CloudRouteProject {
  webhookDomain?: string | null;
}

export interface RouteRegister {
  hostname: string;
  /** Self-hosted upstream, e.g. `http://<ip>:<port>`. Required for self-hosted. */
  targetUrl?: string;
  /** Cloud target port (workspace expose / domains.connect). */
  port?: number;
  isCustomDomain: boolean;
  /**
   * Force (`true`) or suppress (`false`) the `/_openship/hooks/` webhook-proxy
   * location. Omit to auto-detect from the project's `webhookDomain` — callers
   * setting the webhook domain pass it explicitly because the project row isn't
   * updated yet at call time.
   */
  webhook?: boolean;
}

export interface RouteRemove {
  hostname: string;
  isCustomDomain: boolean;
}

export async function reconcileProjectRoutes(
  project: RouteReconcileProject,
  opts: {
    /** Active deployment — resolves the self-hosted routing host when `routing` isn't given. */
    deployment?: Deployment | null;
    /** Pre-resolved self-hosted routing (avoids a second resolveDeploymentRuntime). */
    routing?: Platform["routing"];
    registers?: RouteRegister[];
    removes?: RouteRemove[];
  },
): Promise<void> {
  const registers = opts.registers ?? [];
  const removes = opts.removes ?? [];
  if (registers.length === 0 && removes.length === 0) return;

  // Cloud: page/workspace primitives. The webhook proxy is an nginx concern, so
  // it does not apply here (cloud webhook delivery uses a different path).
  if (project.cloudWorkspaceId) {
    for (const r of removes) await removeCloudProjectRoute(project, r);
    for (const r of registers) {
      await reapplyCloudProjectRoute(project, {
        hostname: r.hostname,
        port: r.port,
        isCustomDomain: r.isCustomDomain,
      });
    }
    return;
  }

  // Self-hosted: the deployment's own routing provider, resolved once.
  const routing =
    opts.routing ??
    (opts.deployment ? (await resolveDeploymentRuntime(opts.deployment)).routing : null);

  if (!routing) {
    // No deployment routing to resolve (e.g. the active deployment was already
    // destroyed, clearing activeDeploymentId). We can't safely REGISTER to an
    // unknown host, but a stray vhost from a prior deploy lives on the local
    // orchestrator, so run REMOVES there — restoring the opportunistic teardown
    // the pre-consolidation code did unconditionally (otherwise the vhost is
    // orphaned → stale 502). On remote-server deploys the route isn't local, so
    // this is a harmless no-op.
    if (removes.length > 0) {
      const local = platform().routing;
      for (const r of removes) {
        await local
          .removeRoute(r.hostname)
          .catch((err) =>
            console.warn(`[route-apply] fallback removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
          );
      }
    }
    if (registers.length > 0) {
      console.warn(
        `[route-apply] no deployment routing resolved — ${registers.length} route(s) not applied (redeploy to re-sync)`,
      );
    }
    return;
  }

  const webhookHost = project.webhookDomain?.trim().toLowerCase() || null;

  for (const r of removes) {
    await routing
      .removeRoute(r.hostname)
      .catch((err) =>
        console.warn(`[route-apply] removeRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
      );
  }

  for (const r of registers) {
    if (!r.targetUrl) {
      console.warn(
        `[route-apply] no upstream resolved for ${r.hostname} — route not applied (redeploy to re-sync)`,
      );
      continue;
    }
    const isWebhook = r.webhook ?? (!!webhookHost && r.hostname.toLowerCase() === webhookHost);
    await routing
      .registerRoute({
        domain: r.hostname,
        tls: true,
        targetUrl: r.targetUrl,
        ...(isWebhook ? { webhookProxy: webhookProxyTarget } : {}),
      })
      .catch((err) =>
        console.warn(`[route-apply] registerRoute ${r.hostname} failed (non-fatal): ${safeErrorMessage(err)}`),
      );
  }
}
