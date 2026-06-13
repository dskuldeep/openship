/**
 * CloudBackupExecutor — backup primitives for Openship Cloud services
 * (services running on Oblien workspaces).
 *
 * Each compose service maps to its own Oblien workspace (see
 * CloudComposeSupport). The workspace disk IS the volume; there's no
 * separate mount concept. So:
 *   - listSources returns a single synthetic source: the workspace
 *     disk at `/app` (or a configurable path).
 *   - execStream / streamPath use `workspaces.exec` with streamStdout.
 *   - receiveStream pipes a tar stream into `tar -x` inside the workspace.
 *   - stopService / startService use workspace lifecycle.
 *
 * The CloudRuntime instance + Oblien client come in through the
 * factory at registration time, mirroring the Docker executor's
 * runtime-injection pattern.
 */

import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { CloudRuntime } from "../../runtime/cloud";
import { registerExecutor } from "../registry";
import type {
  BackupExecutor,
  BackupSource,
  ExecuteCommandOpts,
  ExecExitInfo,
  ReceiveStreamOpts,
  ServiceHandle,
  StreamPathOpts,
} from "../types";

/** Default backup target inside the workspace. Most apps land at /app. */
const DEFAULT_BACKUP_PATH = "/app";

export class CloudBackupExecutor implements BackupExecutor {
  readonly runtimeName = "cloud" as const;

  constructor(private readonly runtime: CloudRuntime) {}

  private get client() {
    return (this.runtime as unknown as { client: import("oblien").Oblien }).client;
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // No granular volume concept on Oblien — the workspace's writable
    // disk is the unit. Future enhancement: parse service.volumes for
    // explicit backup-path overrides (e.g. ["/var/lib/postgresql/data"]).
    if (!service.containerId) return [];
    return [
      {
        id: DEFAULT_BACKUP_PATH,
        source: service.containerId,
        target: DEFAULT_BACKUP_PATH,
        type: "workspace-disk",
      },
    ];
  }

  async execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (!service.containerId) {
      throw new Error(
        `Cannot exec in cloud service ${service.name}: no workspace id`,
      );
    }
    const ws = this.client.workspace(service.containerId);
    const rt = await ws.runtime();

    // Oblien's ExecRunParams doesn't accept env or cwd directly — bake
    // them into the shell command instead.
    const fullCmd = this.composeShellCommand(cmd, opts);

    // rt.exec.stream returns an AsyncGenerator<ExecStreamEvent>. Drive
    // it from a background pump that pushes stdout bytes into our
    // Readable and resolves awaitExit on the `exit` event.
    const stdout = new Readable({ read() {} });
    let stderrBuf = "";

    const awaitExit = new Promise<ExecExitInfo>((resolve, reject) => {
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            stdout.destroy(new Error(`exec timed out after ${opts.timeoutMs}ms`));
            reject(new Error(`exec timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

      const stream = rt.exec.stream(fullCmd, {
        ...(opts?.timeoutMs ? { timeoutSeconds: Math.ceil(opts.timeoutMs / 1000) } : {}),
      });

      const pump = async (): Promise<void> => {
        try {
          let exitCode = 0;
          for await (const ev of stream) {
            switch (ev.event) {
              case "stdout":
                stdout.push(Buffer.from(ev.data, "base64"));
                break;
              case "stderr": {
                const decoded = Buffer.from(ev.data, "base64").toString("utf8");
                stderrBuf += decoded;
                if (stderrBuf.length > 16 * 1024) {
                  stderrBuf = stderrBuf.slice(-16 * 1024);
                }
                break;
              }
              case "exit":
                exitCode = ev.exit_code ?? 0;
                break;
              default:
                // task_id / output / unknown events — ignore.
                break;
            }
          }
          stdout.push(null);
          if (timer) clearTimeout(timer);
          resolve({ code: exitCode, stderr: stderrBuf });
        } catch (err) {
          if (timer) clearTimeout(timer);
          stdout.destroy(err as Error);
          reject(err);
        }
      };
      void pump();
    });

    return { stdout, awaitExit };
  }

  /** Bake env + cwd into a shell command since Oblien's ExecRunParams
   *  doesn't carry them. */
  private composeShellCommand(cmd: string[], opts?: ExecuteCommandOpts): string[] {
    const envPrefix = opts?.env
      ? Object.entries(opts.env)
          .map(([k, v]) => `${k}=${shellEscape(v)}`)
          .join(" ") + " "
      : "";
    const cwdPrefix = opts?.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
    const quotedCmd = cmd.map((arg) => shellEscape(arg)).join(" ");
    return ["sh", "-c", `${cwdPrefix}${envPrefix}${quotedCmd}`];
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    // Default to /app when sourceId matches DEFAULT_BACKUP_PATH; future
    // producers may pass specific db data paths (e.g. /var/lib/postgresql/data).
    const path = sourceId.startsWith("/") ? sourceId : DEFAULT_BACKUP_PATH;
    const compression = opts?.compression ?? "zstd";
    // Each exclude pattern is shell-escaped: producers (and any future
    // caller) supply these via user-facing UI fields, so an unescaped
    // pattern like `foo; rm -rf /` would inject. shellEscape wraps in
    // single quotes — tar's glob handling is unchanged because it sees
    // the literal pattern bytes after the shell strips quotes.
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => [
      "--exclude",
      shellEscape(p),
    ]);
    const tarCmd =
      compression === "zstd"
        ? `tar -c -C ${shellEscape(path)} ${excludeArgs.join(" ")} . | zstd -c -3`
        : compression === "gzip"
          ? `tar -cz -C ${shellEscape(path)} ${excludeArgs.join(" ")} .`
          : `tar -c -C ${shellEscape(path)} ${excludeArgs.join(" ")} .`;
    return this.execStream(service, ["sh", "-c", tarCmd]);
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    if (!service.containerId) {
      throw new Error(
        `Cannot restore to cloud service ${service.name}: no workspace id`,
      );
    }
    const target = targetSourceId.startsWith("/") ? targetSourceId : DEFAULT_BACKUP_PATH;
    const compression = opts?.compression ?? "zstd";
    const ws = this.client.workspace(service.containerId);
    const rt = await ws.runtime();

    let bytesWritten = 0;
    body.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });

    // rt.transfer.upload streams a tar.gz INTO the workspace. We pass
    // body verbatim — Oblien handles the decompression on its end via
    // the `compression` hint.
    await rt.transfer.upload({
      body: body as unknown as ReadableStream<Uint8Array>,
      dest: target,
      ...(opts?.clearTarget ? { clearTarget: true } : {}),
      // Tar.gz vs tar.zst format hint — Oblien's transfer endpoint
      // accepts both via Content-Type / compression param.
      ...(compression === "zstd"
        ? { compression: "zstd" }
        : compression === "gzip"
          ? { compression: "gzip" }
          : {}),
    } as Parameters<typeof rt.transfer.upload>[0]);

    return { bytesWritten };
  }

  async pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo> {
    if (!service.containerId) {
      throw new Error(`Cannot exec in cloud service ${service.name}: no workspace id`);
    }
    // Oblien's exec API doesn't carry stdin. Stage the bytes to a
    // tmp file inside the workspace via rt.transfer.upload, then run
    // the command reading from that file. Slightly less efficient than
    // a true pipe but avoids needing a separate streaming-exec API.
    const ws = this.client.workspace(service.containerId);
    const rt = await ws.runtime();
    // Cryptographic RNG. Math.random is predictable enough that a
    // concurrent attacker on the same workspace could race to either
    // read or overwrite the staged bytes (a restore artifact contains
    // every secret a service can decrypt). 12 hex chars = 48 bits of
    // entropy, comfortably above the collision floor for a tmp path.
    const tmpPath = `/tmp/openship-restore-stdin-${randomBytes(6).toString("hex")}`;

    await rt.transfer.upload({
      body: body as unknown as ReadableStream<Uint8Array>,
      dest: tmpPath,
    } as Parameters<typeof rt.transfer.upload>[0]);

    // Wrap the user's command so its stdin reads from the tmp file,
    // then unlink the file afterward.
    const wrapped = `${this.composeShellCommand(cmd, opts).slice(2).join(" ")} < ${shellEscape(tmpPath)}; ec=$?; rm -f ${shellEscape(tmpPath)}; exit $ec`;
    const result = await this.execStream(service, ["sh", "-c", wrapped]);
    // Drain stdout to /dev/null — caller doesn't read it (the dump is
    // already on disk; commands like pg_restore log to stderr anyway).
    result.stdout.resume();
    return result.awaitExit;
  }

  async stopService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) return;
    try {
      await this.client.workspaces.stop(service.containerId);
    } catch {
      // already stopped — idempotent
    }
  }

  async startService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) {
      throw new Error(`Cannot start cloud service ${service.name}: no workspace id`);
    }
    await this.client.workspaces.start(service.containerId);
  }

  async isRunning(service: ServiceHandle): Promise<boolean> {
    if (!service.containerId) return false;
    try {
      const data = await this.client.workspaces.get(service.containerId);
      return data.status === "running";
    } catch {
      return false;
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

registerExecutor("cloud", (runtime) => {
  if (!(runtime instanceof CloudRuntime)) {
    throw new Error(
      "CloudBackupExecutor requires a CloudRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new CloudBackupExecutor(runtime);
});
