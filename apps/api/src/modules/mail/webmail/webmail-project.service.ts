/**
 * Webmail-as-project bridge.
 *
 * Webmail ships through the SAME deploy pipeline every other project uses,
 * with two narrow divergences:
 *
 *   1. The source is a PRE-BUILT release directory at `apps/email/dist/`
 *      (produced by `bun run build` in `apps/email/`). The deploy just
 *      tar-ships that dir to the target. No build runs at deploy time.
 *      If the dist doesn't exist, the deploy fails fast with instructions
 *      to build it first.
 *
 *   2. Install / start commands target the release layout - `bun install`
 *      runs inside `server/` (where the runtime deps live), and start is
 *      `bun run server/src/main.ts` with `CLIENT_BUILD_DIR` pointing at
 *      the bundled `client/` next to it.
 *
 * Everything else - preflight, toolchain (bun), workspace transfer,
 * OpenResty vhost, Let's Encrypt cert, lifecycle hooks - is the standard
 * `createQueuedDeployment` → `startBuild` path. The bespoke 10-step
 * engine that used to live here is gone. The previous "build on the
 * target" flow is gone too - it OOM-killed small VPSes during the Vite
 * SSR pass; pre-building avoids that entirely.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { repos, type Project } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { sshManager } from "../../../lib/ssh-manager";
import { assertResourceInOrg } from "../../../lib/controller-helpers";
import type { RequestContext } from "../../../lib/request-context";
import { fetchAndExtractRelease } from "../../system/migration/lib/release-download";
import {
  buildConfigSnapshot,
  createQueuedDeployment,
  encryptEnvVars,
  metaWithPrevious,
  resolveSnapshotTarget,
  runDeploymentPreflight,
  startBuild,
} from "../../deployments/build.service";
import * as settingsService from "../../settings/settings.service";
import {
  listProjectRouteRows,
  syncProjectRouteState,
} from "../../domains/project-route.service";
import {
  readState,
  writeState,
  type MailWebmailState,
  type MailServerState,
} from "../mail-state";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_NAME = "Webmail";

/**
 * Persistent webmail state on the target. The standard pipeline wipes the
 * per-deploy workspace on every redeploy, so anything that must survive
 * (branding config, the SQLite session DB) lives under this dir instead.
 */
const REMOTE_PERSIST_DIR = "/var/lib/openship-webmail";
const REMOTE_BRANDING_DIR = `${REMOTE_PERSIST_DIR}/branding`;
const REMOTE_SQLITE_PATH = `${REMOTE_PERSIST_DIR}/zero.db`;

/** Internal port Zero binds to behind the OpenResty vhost the pipeline creates. */
const DEFAULT_INTERNAL_PORT = 4080;

/** GitHub repo for release downloads. Same repo as openship - mono-version. */
const RELEASE_REPO = "oblien/openship";

/**
 * apps/api/ directory, used to find the root package.json (for version)
 * and the repo-local `apps/email/dist/` dev path.
 *
 * This file lives at apps/api/src/modules/mail/webmail/webmail-project.service.ts,
 * so 4 levels up reaches apps/api/. Mirrors the ESM-safe pattern in
 * openship-dist.ts.
 */
const __dirname = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url), "..");
  } catch {
    // CJS fallback (tests, scripts) - walk back up from cwd.
    return resolve(process.cwd(), "apps/api/src/modules/mail/webmail");
  }
})();
const API_ROOT = resolve(__dirname, "../../../..");

/**
 * Read the API's own version from package.json. Embedded at first call
 * and cached. We use the API version as the openship release tag because
 * the email/webmail release ships at the SAME tag as the rest of openship
 * (mono-version).
 */
let cachedVersion: string | undefined;
function readApiVersion(): string {
  if (cachedVersion) return cachedVersion;
  const pkgPath = join(API_ROOT, "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      cachedVersion = parsed.version;
      return cachedVersion;
    }
    throw new Error(`package.json at ${pkgPath} has no version field`);
  } catch (err) {
    throw new Error(
      `Cannot read Openship API version from ${pkgPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Root for downloaded release caches. Mirrors openship-dist.ts. */
function computeDataDir(): string {
  return process.env.OPENSHIP_DATA_DIR ?? join(homedir(), ".openship");
}

/** Repo-local dev path produced by `bun run build` in apps/email/. */
function computeRepoLocalEmailDistPath(): string {
  // apps/api/ → ../email/dist
  return resolve(API_ROOT, "..", "email", "dist");
}

export class WebmailReleaseDistMissingError extends Error {
  readonly code = "WEBMAIL_RELEASE_DIST_MISSING" as const;
  constructor(distPath: string, options?: { cause?: unknown }) {
    super(
      `Webmail release dist not found at ${distPath}. ` +
        `Build it first: \`cd apps/email && bun run build\`, ` +
        `or set MAIL_WEBMAIL_SOURCE_DIR to point at an existing apps/email/ checkout ` +
        `whose dist/ directory has been built.`,
      options,
    );
    this.name = "WebmailReleaseDistMissingError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the path to the pre-built webmail dist on the API host using
 * the three-slot resolution order (mirrors openship-dist.ts):
 *
 *   1. MAIL_WEBMAIL_SOURCE_DIR env override (highest priority). Points at
 *      an apps/email/ checkout whose `dist/` has been built. For Docker
 *      images, custom CI bundles, air-gapped installs, tests.
 *   2. <repoRoot>/apps/email/dist/ - the dev path produced by
 *      `cd apps/email && bun run build`.
 *   3. <dataDir>/email-dist/v<version>/ - production cache. On a miss,
 *      downloads the matching GitHub release tarball and extracts it
 *      here. `<dataDir>` is OPENSHIP_DATA_DIR or ~/.openship. The tag
 *      matches the API version (mono-version with openship-dist).
 *
 * The client reads its backend URL from `window.location.origin` at
 * runtime, so one dist deploys to any hostname unchanged - no env
 * required at build time.
 *
 * If all three slots fail, throws WebmailReleaseDistMissingError. The
 * download error (if any) is attached as the `cause` so the operator
 * sees both the network failure and the env-override escape hatch.
 *
 * Note: async because the cache-miss path performs a network download.
 * The env-override and repo-local-hit branches are still effectively
 * synchronous (they return on the same microtask tick).
 */
async function resolveWebmailDistDir(): Promise<string> {
  // Slot 1: explicit env override. Points at an apps/email/ checkout;
  // mirror the previous behavior of joining `dist` underneath it.
  const override = process.env.MAIL_WEBMAIL_SOURCE_DIR;
  if (override) {
    const dir = resolve(override, "dist");
    if (existsSync(dir)) return dir;
    throw new WebmailReleaseDistMissingError(dir);
  }

  // Slot 2: repo-local dev path.
  const repoLocal = computeRepoLocalEmailDistPath();
  if (existsSync(repoLocal)) return repoLocal;

  // Slot 3: <dataDir>/email-dist/v<version>/ - download on miss.
  const version = readApiVersion();
  const tag = `v${version}`;
  const cacheDir = join(computeDataDir(), "email-dist");
  const cachedTarget = join(cacheDir, tag);
  if (existsSync(cachedTarget)) return cachedTarget;

  try {
    const result = await fetchAndExtractRelease({
      repo: RELEASE_REPO,
      asset: `openship-email-${tag}-linux-amd64.tar.gz`,
      tag,
      cacheDir,
    });
    return result.path;
  } catch (err) {
    throw new WebmailReleaseDistMissingError(cachedTarget, { cause: err });
  }
}

function deriveAcmeEmail(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  const base = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  return `admin@${base}`;
}

/**
 * The only operational concern that doesn't fit in the standard pipeline:
 * a persistent branding dir outside the workspace. The pipeline wipes the
 * workspace on every redeploy; branding config has to live somewhere else.
 *
 * Bun itself is installed by `ensureToolchain` via the standard catalog
 * (webmail stack declares `requiredTools: ["bun"]`) - no bespoke install here.
 */
async function prepareTarget(serverId: string): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    await exec.mkdir(REMOTE_PERSIST_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_PERSIST_DIR}`);
    await exec.mkdir(REMOTE_BRANDING_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_BRANDING_DIR}`);
    // The runtime adapter (re-)chowns these to the sandbox user on every
    // deploy, but doing it here too means a fresh server has the dirs in
    // the right shape before the first deploy starts - no permission
    // shuffle mid-pipeline that the user might see scroll past.
  });
}

async function persistWebmailBlock(
  mailServerId: string,
  block: MailWebmailState,
): Promise<void> {
  await sshManager.withExecutor(mailServerId, async (exec) => {
    const state = await readState(exec);
    if (!state) {
      throw new Error(
        "Could not persist webmail state - mail state file is missing on the server.",
      );
    }
    const next: MailServerState = { ...state, webmail: block };
    await writeState(exec, next);
  });
}

/**
 * Read the existing webmail block (if any) so a redeploy can reuse the
 * branding token + session encryption key. Returns null on any failure -
 * the caller falls back to minting fresh secrets.
 */
async function readExistingWebmailBlock(
  mailServerId: string,
): Promise<{ block: MailWebmailState | null; installDomain: string | null }> {
  try {
    let block: MailWebmailState | null = null;
    let installDomain: string | null = null;
    await sshManager.withExecutor(mailServerId, async (exec) => {
      const state = await readState(exec);
      block = state?.webmail ?? null;
      installDomain = state?.domain ?? null;
    });
    return { block, installDomain };
  } catch {
    return { block: null, installDomain: null };
  }
}

/**
 * Flip the `installed` flag on the mail-state webmail block to true.
 * Called from the deployment success hook so a failed build never leaves
 * a stale "Open webmail" CTA. Returns silently if the block is missing
 * (the deploy didn't go through `startWebmailDeploy` - nothing to flip).
 *
 * For cloud deploys to the mail server's own `mail.<install>` subdomain
 * we ALSO register an OpenResty proxy route on the mail VPS that points
 * `mail.<install>` → the Opshcloud URL. Operators can't change DNS for
 * that subdomain (it's pinned to the mail VPS for IMAP/SMTP), so the
 * mail VPS proxies it for them.
 *
 * The mailServerId is derived from the project slug (`webmail-<id>`) -
 * the slug is the only piece of webmail context that survives into the
 * generic deployment lifecycle.
 */
export async function markWebmailInstalled(
  mailServerId: string,
  organizationId: string,
  deployedUrl?: string,
): Promise<void> {
  try {
    let needsProxy = false;
    let proxyHostname = "";
    let proxyUpstream = "";

    await sshManager.withExecutor(mailServerId, async (exec) => {
      const state = await readState(exec);
      if (!state?.webmail) return;

      // Detect: was this deploy on Opshcloud, targeted at the mail
      // server's own mail.<install> subdomain? If so we'll register the
      // proxy AFTER the state write below.
      const installDomain = state.domain;
      const wm = state.webmail;
      const isCloud = wm.target === "cloud";
      const isOwnMailSubdomain =
        !!installDomain && wm.hostname === `mail.${installDomain}`;
      needsProxy = isCloud && isOwnMailSubdomain && !!deployedUrl;

      if (needsProxy) {
        proxyHostname = wm.hostname;
        proxyUpstream = deployedUrl!;
      }

      const next: MailServerState = {
        ...state,
        webmail: {
          ...wm,
          installed: true,
          deployedAt: new Date().toISOString(),
          ...(deployedUrl ? { cloudUrl: isCloud ? deployedUrl : wm.cloudUrl } : {}),
        },
      };
      await writeState(exec, next);
    });

    if (needsProxy) {
      await registerWebmailCloudProxy(mailServerId, proxyHostname, proxyUpstream, organizationId);
    }
  } catch (err) {
    console.warn(
      `[webmail] could not flip installed=true for ${mailServerId}: ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Register an OpenResty proxy on the mail VPS:
 *   `https://<hostname>` → `<cloudUrl>`
 *
 * Used only for the cloud-deploy-with-mail-subdomain case (mail.<install>
 * can't be repointed via DNS, so the mail VPS proxies on the operator's
 * behalf). For every other case the standard project-pipeline routing
 * already handled the hostname.
 *
 * Provisions a Let's Encrypt cert as part of the registration. Failures
 * are non-fatal here - the proxy can be retried by a redeploy.
 */
async function registerWebmailCloudProxy(
  mailServerId: string,
  hostname: string,
  cloudUrl: string,
  organizationId: string,
): Promise<void> {
  // resolveTargetPlatform gives us the mail VPS's openresty + ssl -
  // same platform that fronts IMAP/SMTP traffic for this hostname today.
  // org-scoped: resolveTargetPlatform verifies mailServerId ∈ org.
  const { resolveTargetPlatform } = await import("../../../lib/deployment-runtime");
  const platform = await resolveTargetPlatform("server", "bare", mailServerId, organizationId);

  await platform.routing.registerRoute({
    domain: hostname,
    tls: true,
    targetUrl: cloudUrl,
  });
  // Provision a cert for the proxy hostname. The mail VPS already has
  // certs for IMAP/SMTP STARTTLS - this adds the HTTPS-on-:443 cert
  // for the webmail UI. Reuses the existing Let's Encrypt feature.
  await platform.ssl.provisionCert(hostname);
}

/** Extract the mailServerId encoded in a `webmail-<id>` project slug. */
export function mailServerIdFromWebmailSlug(slug: string): string | null {
  const m = slug.match(/^webmail-(.+)$/);
  return m?.[1] ?? null;
}

/**
 * Webmail-specific teardown that the generic project cleanup doesn't cover:
 *
 *   - The persistent branding dir on the target host (it lives outside the
 *     deploy artifact dir, since the standard pipeline wipes the workspace
 *     on every redeploy - so the generic runtime.destroy never touches it).
 *   - The `webmail` block in mail-state.json on the mail VPS, so a future
 *     re-deploy starts fresh instead of inheriting a stale brandingToken
 *     or `installed=true` flag.
 *
 * Called from project-cleanup.service after the standard manifest cleanup
 * (containers, routes, artifacts) has finished. All failures are swallowed
 * - the project rows are already soft-deleted, so a failing branding-dir
 * remove can't strand the user; it just leaves /var/lib/openship-webmail
 * behind until the next deploy reuses it.
 */
export async function cleanupWebmailInstall(input: {
  mailServerId: string;
}): Promise<void> {
  // 1. Read the webmail block to find the target host (webmail may live on
  //    a separate server from the mail VPS) BEFORE we wipe the block.
  let targetServerId: string | null = null;
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      const state = await readState(exec);
      targetServerId = state?.webmail?.targetServerId ?? null;
    });
  } catch (err) {
    console.warn(
      `[webmail] could not read mail-state on ${input.mailServerId}: ${safeErrorMessage(err)}`,
    );
  }

  // 2. Wipe the persistent branding dir on the target host.
  if (targetServerId) {
    try {
      await sshManager.withExecutor(targetServerId, async (exec) => {
        await exec.rm(REMOTE_BRANDING_DIR);
      });
    } catch (err) {
      console.warn(
        `[webmail] could not remove branding dir on ${targetServerId}: ${safeErrorMessage(err)}`,
      );
    }
  }

  // 3. Strip the webmail block from mail-state on the mail VPS.
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      const state = await readState(exec);
      if (!state?.webmail) return;
      const next: MailServerState = { ...state };
      delete next.webmail;
      await writeState(exec, next);
    });
  } catch (err) {
    console.warn(
      `[webmail] could not clear mail-state webmail block on ${input.mailServerId}: ${safeErrorMessage(err)}`,
    );
  }
}

// ─── Project ensure ──────────────────────────────────────────────────────────

/**
 * Find-or-create the project row for this webmail install. Keyed off the
 * mail server ID so redeploys reuse the same project. `localPath` points
 * at the freshly built release dist for this deploy - the standard
 * pipeline streams that to the target, runs install, and starts.
 *
 * The release dist already contains a pre-built client SPA and the
 * server source, so the target does NO build work. `buildCommand` is
 * intentionally empty - the pipeline detects that and skips the build
 * step entirely (see runBuildPipeline at line 211 in build-pipeline.ts).
 */
export async function ensureWebmailProject(
  organizationId: string,
  mailServerId: string,
  releaseDistPath: string,
): Promise<{ projectId: string; appId: string; project: Project }> {
  const slug = `webmail-${mailServerId}`;

  // Fixed config - the user can't edit these on the project row, and we
  // reconcile every deploy.
  //
  // Layout of the shipped dist (see apps/email/scripts/build-release.ts):
  //   <remoteDir>/
  //     package.json        ← release orchestration
  //     client/             ← pre-built SPA (no node_modules)
  //     server/
  //       package.json      ← runtime deps only
  //       src/              ← bun runs TS directly
  //       tsconfig.json
  //
  // installCommand:  `cd server && bun install --production` - only the
  //                  server has deps (client is already bundled).
  // buildCommand:    empty - there's nothing to build on the target.
  // startCommand:    `CLIENT_BUILD_DIR=...` points the server at the
  //                  bundled SPA so it can serve /* as static files.
  const WEBMAIL_CONFIG = {
    framework: "webmail",
    packageManager: "bun",
    // --frozen-lockfile fails the install if the dist's bun.lock and
    // package.json drift - better to error loudly than to silently
    // resolve to a different version on the target (we hit that exact
    // bug when shipping without a lockfile: `^0.3.4` resolved to 0.4.2
    // on the target, breaking the peer-dep contract).
    installCommand: "cd server && bun install --production --frozen-lockfile",
    buildCommand: "",
    outputDirectory: "",
    startCommand: 'CLIENT_BUILD_DIR="$PWD/client" bun run server/src/main.ts',
    productionMode: "host" as const,
    port: DEFAULT_INTERNAL_PORT,
    hasServer: true,
    // hasBuild gates BOTH install and build in the build-config factory
    // (`installCommand: hasBuild ? cmd : ""`). Webmail has no build step
    // (`buildCommand: ""`) but it DOES need an install - `bun install`
    // resolves runtime deps in `server/` against the shipped lockfile.
    // So we set hasBuild=true to let install through. buildCommand="" is
    // honored downstream and the build step is cleanly skipped.
    hasBuild: true,
    buildImage: "oven/bun:latest",
    localPath: releaseDistPath,
  };

  // Webmail slug is `webmail-<mailServerId>` which is deterministically
  // unique per mail server, but the row must also be scoped to the active
  // org so a different org redeploying webmail against its own mail server
  // creates a fresh project row instead of finding a cross-org one.
  //
  // Look up by globally-unique slug, then assert org ownership. If the
  // existing row belongs to a different org, treat it as "not found" and
  // create a fresh one — assertResourceInOrg throws NotFoundError for
  // out-of-org rows, which we catch and fall through to create.
  let app = await repos.projectApp.findFirstBySlug(slug);
  if (app && app.organizationId !== organizationId) {
    app = undefined;
  }
  if (!app) {
    app = await repos.projectApp.create({
      organizationId,
      name: PROJECT_NAME,
      slug,
    });
  }

  let project = await repos.project.findFirstBySlug(slug);
  if (project && project.organizationId !== organizationId) {
    project = undefined;
  }
  if (!project) {
    project = await repos.project.create({
      organizationId,
      appId: app.id,
      name: PROJECT_NAME,
      slug,
      environmentName: "Production",
      environmentSlug: "production",
      environmentType: "production",
      ...WEBMAIL_CONFIG,
    });
  } else {
    // Defensive: confirm the row really is in this org before we mutate it.
    // findFirstBySlug is unscoped so we double-check here.
    assertResourceInOrg(project, "Project", organizationId, project.id);
    // Reconcile every deploy: fixed commands aren't user-editable, so a
    // divergence means we shipped a change since this row was created.
    const diverged = (Object.keys(WEBMAIL_CONFIG) as Array<keyof typeof WEBMAIL_CONFIG>).some(
      (k) => (project as Record<string, unknown>)[k] !== WEBMAIL_CONFIG[k],
    );
    if (diverged) {
      await repos.project.update(project.id, WEBMAIL_CONFIG);
      project = { ...project, ...WEBMAIL_CONFIG };
    }
  }

  return { projectId: project.id, appId: app.id, project };
}

// ─── Deploy lifecycle ────────────────────────────────────────────────────────

/**
 * Where to run the webmail. Discriminated union - `self` for a
 * user-managed openship server, `cloud` for Opshcloud.
 */
export type WebmailDeployTarget =
  | { kind: "self"; serverId: string }
  | { kind: "cloud" };

export interface StartWebmailDeployInput {
  mailServerId: string;
  hostname: string;
  internalPort?: number;
  target: WebmailDeployTarget;
}

export interface StartWebmailDeployResult {
  deploymentId: string;
  projectId: string;
}

/**
 * Drive a webmail deploy through the standard project pipeline.
 *
 * Flow:
 *   1. Locate the pre-built dist at `apps/email/dist/` (fail-fast if absent).
 *   2. Reconcile the project row to that dist + the fixed webmail config.
 *   3. Sync the project route (hostname → OpenResty + Let's Encrypt).
 *   4. Mint / reuse the branding token + session key in mail-state.
 *   5. Ensure persistent dirs on the target (/var/lib/openship-webmail).
 *   6. Build the env map (PORT, COOKIE_DOMAIN, IMAP/SMTP, secrets…).
 *   7. Snapshot from the project, resolve the deploy target via
 *      resolveSnapshotTarget (webmail intent as the override) and the
 *      explicit `buildStrategy = "server"` via resolveStrategy (the
 *      pipeline's "build the image at the target" mode — image build runs
 *      on the target host / cloud builder, not the API host).
 *   8. Preflight - port availability, hostname validity, required fields.
 *   9. `createQueuedDeployment` + `startBuild`.
 *
 * The pipeline's build step is a no-op for webmail: the project's
 * `buildCommand` is empty so `runBuildPipeline` skips it (see
 * build-pipeline.ts:211). Install runs in `server/` only (just runtime
 * deps), then start boots `bun run server/src/main.ts` which serves the
 * bundled `client/` next to it as static files.
 */
export async function startWebmailDeploy(
  ctx: RequestContext,
  input: StartWebmailDeployInput,
): Promise<StartWebmailDeployResult> {
  // ── 0. Org-scope guard (IDOR). The deploy route is tagged
  //       mail_server:write with NO :id param, so the framework only
  //       proved org membership — NOT that mailServerId (or the chosen
  //       target server) belongs to this org. Verify here, before any
  //       SSH / state read / build, so a member of org A can't deploy
  //       webmail onto org B's mail server by passing its id.
  const mailServer = await repos.server.get(input.mailServerId).catch(() => null);
  assertResourceInOrg(mailServer, "mail_server", ctx.organizationId, input.mailServerId);
  if (input.target.kind === "self") {
    const targetServer = await repos.server.get(input.target.serverId).catch(() => null);
    assertResourceInOrg(targetServer, "server", ctx.organizationId, input.target.serverId);
  }

  const internalPort = input.internalPort ?? DEFAULT_INTERNAL_PORT;
  const publicUrl = `https://${input.hostname}/`;
  const publicOrigin = `https://${input.hostname}`;

  // ── 1. Locate the pre-built webmail dist on the API host. NO build
  //       runs here - the dist must already exist (operator runs
  //       `bun run build` in apps/email/ ahead of time, OR we download
  //       the matching release tarball from GitHub into the cache).
  //       If all three slots fail, fail fast with a clear message. ────
  const releaseDistPath = await resolveWebmailDistDir();

  // ── 2. Project row carries localPath (the dist) + fixed config ──────
  const { project, projectId } = await ensureWebmailProject(
    ctx.organizationId,
    input.mailServerId,
    releaseDistPath,
  );

  // ── 3. Read mail-state for install domain + reuse existing branding /
  //       session-key secrets. Needed before route sync because the
  //       cloud + mail.<install> case skips custom-domain routing on
  //       the deploy target (the mail VPS proxies for it instead). ───
  const { block: existingState, installDomain: mailInstallDomain } =
    await readExistingWebmailBlock(input.mailServerId);
  if (!mailInstallDomain) {
    // Without the mail VPS's install domain we can't tell Zero where IMAP /
    // SMTP live, and every webmail sign-in would fall back to
    // `mail.<userDomain>` - broken for additional domains, and a TLS-cert
    // mismatch for any user whose domain isn't the install one. Fail fast
    // here rather than ship a webmail that can't authenticate anyone.
    throw new Error(
      "Mail server install state is missing - finish the mail install before deploying webmail.",
    );
  }

  // When the chosen hostname is the mail VPS's own `mail.<install>`
  // subdomain, the DNS A record already pins it to the mail server (for
  // IMAP / SMTP). The operator CAN'T change that record without breaking
  // mail. So if they pick Opshcloud as the target, the cloud workload
  // gets a default *.opsh.io URL and the mail server's OpenResty proxies
  // `mail.<install>` → that URL. No DNS work for the operator.
  //
  // For any OTHER hostname (e.g. `webmail.foo.com`), the operator owns
  // DNS and points it themselves - normal cloud / self-hosted custom
  // domain flow.
  const isOwnMailSubdomain = input.hostname === `mail.${mailInstallDomain}`;
  const useProxyVariant = input.target.kind === "cloud" && isOwnMailSubdomain;

  // ── 4. Project route - for the proxy variant we DON'T register the
  //       hostname against the project (the cloud workload uses opsh.io;
  //       the mail VPS handles the public hostname via its own routing).
  //       Every other case goes through the standard custom-domain path. ─
  const projectDomains = await listProjectRouteRows(project.id);
  const routeState = await syncProjectRouteState(project, {
    projectDomains,
    nextPublicEndpoints: useProxyVariant
      ? [] // no custom domain on the cloud workload - proxy lives on mail VPS
      : [
          {
            port: internalPort,
            customDomain: input.hostname,
            domainType: "custom",
          },
        ],
  });

  // ── 5. Mint / reuse secrets, persist mail-state. `installed` stays
  //       false until the deploy success hook flips it. ─────────────────
  const brandingToken =
    existingState?.brandingToken ?? randomBytes(32).toString("hex");
  const sessionEncryptionKey =
    existingState?.sessionEncryptionKey ?? randomBytes(32).toString("hex");
  const webmailState: MailWebmailState = {
    installed: false,
    target: input.target.kind === "cloud" ? "cloud" : "self",
    targetServerId: input.target.kind === "self" ? input.target.serverId : "",
    hostname: input.hostname,
    url: publicUrl,
    internalPort,
    brandingToken,
    sessionEncryptionKey,
    deployedAt: new Date().toISOString(),
    version: "local",
  };
  await persistWebmailBlock(input.mailServerId, webmailState);

  // ── 6. Persistent dirs on the target - only meaningful for self-hosted
  //       deploys. Cloud runs in an ephemeral container managed by
  //       Opshcloud; persistence there is handled by the cloud platform. ─
  if (input.target.kind === "self") {
    await prepareTarget(input.target.serverId);
  }

  // ── 7. Build the env map in memory. Webmail env vars are fixed by
  //       openship (not user-editable in the project Env Vars UI), so we
  //       bypass the project envVar table and pass them straight to the
  //       deployment - same direct path requestBuildAccess uses for
  //       caller-supplied vars. ACME_EMAIL is read by the SSL feature
  //       installer.
  //
  // IMAP / SMTP coordinates Zero uses to authenticate every sign-in.
  // Pinning to `mail.<installDomain>:993/465` here makes every user's
  // login route to the actual MTA, matching what `test-email.service.ts`
  // and `mail-credentials.service.ts` already use server-side.
  //
  // Public URLs are NOT injected here - the client reads its backend
  // URL from `window.location.origin` at runtime (see
  // client/lib/backend-url.ts). One dist, any hostname.
  //
  // SQLITE / BRANDING paths only point at the persistent host dir for
  // self-hosted deploys. Cloud writes to the container-local filesystem
  // (the cloud platform owns its own state layer); the defaults baked
  // into env.ts (`./data/...`) apply when these are omitted.
  const mailHost = `mail.${mailInstallDomain}`;
  const plainEnvMap: Record<string, string> = {
    PORT: String(internalPort),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    COOKIE_DOMAIN: input.hostname,
    TRUSTED_ORIGINS: publicOrigin,
    SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    BRANDING_ADMIN_TOKEN: brandingToken,
    DEFAULT_IMAP_HOST: mailHost,
    DEFAULT_IMAP_PORT: "993",
    DEFAULT_SMTP_HOST: mailHost,
    DEFAULT_SMTP_PORT: "465",
    ACME_EMAIL: deriveAcmeEmail(input.hostname),
  };
  if (input.target.kind === "self") {
    plainEnvMap.SQLITE_PATH = REMOTE_SQLITE_PATH;
    plainEnvMap.BRANDING_PATH = REMOTE_BRANDING_DIR;
  }

  // ── 8. Snapshot - same helper requestBuildAccess uses. The project row
  //       owns build/install/start commands + port + localPath. We only
  //       override the deploy-target picker bits the normal UI exposes. ──
  const snapshot = buildConfigSnapshot(project, "main");
  snapshot.serviceDeploymentMode = "single";

  // Route the deploy target through the same authority the normal deploy entry
  // points use, passing webmail's known intent as the override — instead of
  // hand-pinning the fields (which re-implemented serverId-gating and could drift
  // from resolveSnapshotTarget). Cloud → cloud runtime (docker-in-cloud); self →
  // image built + run on the operator's server (docker sandbox over SSH).
  const target = await resolveSnapshotTarget(project, {
    deployTarget: input.target.kind === "cloud" ? "cloud" : "server",
    serverId: input.target.kind === "self" ? input.target.serverId : undefined,
    runtimeMode: "docker",
  });
  snapshot.deployTarget = target.deployTarget;
  snapshot.serverId = target.serverId;
  snapshot.runtimeMode = target.runtimeMode;

  // `"server"` build strategy is webmail's INTENTIONAL explicit choice: the image
  // build happens at the deploy target (target host via dockerode-over-SSH for
  // self-hosted, or the cloud platform's builder for cloud), not on the API host.
  // Pass it as the explicit value to the authority (which honors an explicit
  // choice) so the decision still flows through resolveStrategy.
  snapshot.buildStrategy = await settingsService.resolveStrategy(snapshot.framework, "server", {
    deployTarget: target.deployTarget,
  });

  // ── 9. Preflight - same call for both targets. The preflight dispatcher
  //       in deployments/preflight.ts branches on snapshot.deployTarget
  //       (cloud-side checks domain availability via Oblien, self-hosted
  //       checks port availability + SSH reachability). ─────────────────
  await runDeploymentPreflight(snapshot, routeState, { ctx });

  // ── 9. Encrypt + attach the env map directly to the deployment row.
  //       executeBuildAndDeploy reads dep.envVars, decrypts, and feeds
  //       them to runtime.build + runtime.deploy. ──────────────────────
  const dep = await createQueuedDeployment({
    projectId,
    organizationId: ctx.organizationId,
    branch: "main",
    environment: "production",
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptEnvVars(plainEnvMap),
    trigger: "manual",
  });

  // Fire-and-forget - the standard pipeline owns logging, SSE, lifecycle.
  await startBuild(dep.id);

  return { deploymentId: dep.id, projectId };
}


