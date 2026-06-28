/**
 * Startup-hook registration — Self-hosted only (never SaaS).
 *
 * The single, explicit place where each feature's startup hook is registered.
 * Imported once from app.ts before `runStartupHooks()` runs, so registration
 * order is deterministic and not dependent on incidental module-load order.
 * Add new feature hooks here.
 */
import { registerTunnelAutostart } from "../ssh-tunnel-manager";

export function registerStartupHooks(): void {
  // Desktop: re-open saved port-forward tunnels marked auto-start.
  registerTunnelAutostart();
}
