/**
 * DockerBackupExecutor — backup primitives for Docker-managed services.
 *
 * Strategy: helper container with `--volumes-from <target> -v <volume>:/mnt`
 * runs tar inside the same volume namespace as the target service.
 * Stdout of the helper container is a tar.gz stream that the orchestrator
 * pipes to the destination — bytes never land on the API host.
 *
 * The helper image is `alpine:3` (already present on most Docker hosts;
 * pulled once if missing). It carries busybox tar + the script we exec
 * directly (no `--volumes-from` mounting trickery beyond what dockerode
 * already exposes through HostConfig).
 */

import type Dockerode from "dockerode";
import { PassThrough, Readable } from "node:stream";
import { DockerRuntime } from "../../runtime/docker";
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

const HELPER_IMAGE = "alpine:3";

/** Single-quote shell escape — safe for arbitrary user-supplied
 *  values passed to `sh -c`. Wraps in single quotes and replaces any
 *  inner ' with the standard '\'' sequence. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Compression options exposed by the busybox+zstd alpine image. */
function compressionFlag(compression: "zstd" | "gzip" | "none" | undefined): string {
  switch (compression) {
    case "gzip":
      return "z";
    case "zstd":
      // busybox tar doesn't speak zstd directly; we pipe through `zstd -c`
      // — handled separately in the command builder below.
      return "";
    case "none":
    default:
      return "";
  }
}

/** Parse a compose-syntax volume string into the executor's source shape. */
function parseVolumeSpec(spec: string): { source: string; target: string; type: BackupSource["type"] } | null {
  // Strip mode suffix (":ro" / ":rw" etc.)
  const noMode = spec.replace(/:(ro|rw|z|Z|nocopy)$/, "");
  const parts = noMode.split(":");
  if (parts.length === 1) {
    // Anonymous volume — bare container path. Not backupable in v1
    // (Docker auto-removes anonymous volumes with the container).
    return { source: "", target: parts[0], type: "tmpfs" };
  }
  const [source, target] = parts;
  // Heuristic: a source that looks like a host path (starts with `.` or `/`)
  // is a bind mount. Otherwise treat as a named volume.
  const type: BackupSource["type"] =
    source.startsWith("/") || source.startsWith("./") || source.startsWith("../")
      ? "bind"
      : "volume";
  return { source, target, type };
}

export class DockerBackupExecutor implements BackupExecutor {
  readonly runtimeName = "docker" as const;

  constructor(private readonly runtime: DockerRuntime) {}

  private get dockerode(): Dockerode {
    return this.runtime.docker;
  }

  async listSources(service: ServiceHandle): Promise<BackupSource[]> {
    // Two sources of truth:
    //  1. Live container's actual Mounts (authoritative when the
    //     service is deployed). Captures Docker's resolution of relative
    //     paths and named-volume namespacing.
    //  2. service.volumes from the DB (fallback when the container
    //     isn't running or doesn't exist yet).
    if (service.containerId) {
      try {
        const data = await this.dockerode
          .getContainer(service.containerId)
          .inspect();
        const mounts = (data.Mounts ?? []) as Array<{
          Type?: string;
          Name?: string;
          Source?: string;
          Destination?: string;
        }>;
        return mounts
          .filter((m) => m.Type === "volume" || m.Type === "bind")
          .map((m, i): BackupSource => ({
            id: m.Name ?? m.Source ?? `mount-${i}`,
            target: m.Destination ?? "",
            source: m.Name ?? m.Source ?? "",
            type: (m.Type as BackupSource["type"]) ?? "volume",
          }));
      } catch {
        // Container gone — fall through to the DB-declared volumes.
      }
    }

    return service.volumes
      .map((spec, i): BackupSource | null => {
        const parsed = parseVolumeSpec(spec);
        if (!parsed || !parsed.source) return null;
        return {
          id: `${parsed.source}-${i}`,
          source: parsed.source,
          target: parsed.target,
          type: parsed.type,
        };
      })
      .filter((x): x is BackupSource => x !== null);
  }

  async execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    if (!service.containerId) {
      throw new Error(
        `Cannot exec in service ${service.name}: no containerId. Service must be deployed.`,
      );
    }

    const container = this.dockerode.getContainer(service.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      User: opts?.user,
      WorkingDir: opts?.cwd,
      Env: opts?.env
        ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    return this.attachDemuxed(this.dockerode, exec.id, stream, opts?.timeoutMs);
  }

  async streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }> {
    const sources = await this.listSources(service);
    const source = sources.find((s) => s.id === sourceId);
    if (!source) {
      throw new Error(`Backup source "${sourceId}" not found on service ${service.name}`);
    }
    if (source.type === "tmpfs") {
      throw new Error(`Backup source "${sourceId}" is tmpfs — not backupable`);
    }

    // Build the helper container command. Tar reads from /mnt and writes
    // to stdout. zstd compression is piped externally because busybox
    // doesn't link it.
    const compression = opts?.compression ?? "zstd";
    // shellEscape each pattern — these flow from user-facing fields,
    // an unescaped `; rm -rf /` would inject. tar's glob handling is
    // unchanged because the shell strips the quotes before exec.
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => [
      "--exclude",
      shellEscape(p),
    ]);
    const tarFlags = compressionFlag(compression);
    const tarCmd =
      compression === "zstd"
        ? `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} . | zstd -c -3`
        : `tar -c${tarFlags} -C /mnt ${excludeArgs.join(" ")} .`;
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;

    await this.ensureImage(helperImage);

    const hostConfig: Dockerode.HostConfig = source.type === "bind"
      ? { Binds: [`${source.source}:/mnt:ro`], AutoRemove: true }
      : { Binds: [`${source.source}:/mnt:ro`], AutoRemove: true };

    const helper = await this.dockerode.createContainer({
      Image: helperImage,
      Cmd: ["sh", "-c", compression === "zstd" ? `apk add --no-cache zstd >/dev/null 2>&1; ${tarCmd}` : tarCmd],
      HostConfig: hostConfig,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      // No network — backup helper doesn't need to phone home.
      NetworkDisabled: true,
    });

    const stream = await helper.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });
    await helper.start();
    return this.demuxContainerStream(helper, stream, opts ? (opts as ExecuteCommandOpts).timeoutMs : undefined);
  }

  async receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }> {
    // Restore path — re-uses the helper-container pattern but inverted:
    // stdin is the tar stream, the helper extracts into /mnt.
    const sources = await this.listSources(service);
    const source = sources.find((s) => s.id === targetSourceId);
    if (!source) {
      throw new Error(`Restore target "${targetSourceId}" not found on service ${service.name}`);
    }
    if (source.type === "tmpfs") {
      throw new Error(`Restore target "${targetSourceId}" is tmpfs — not restorable`);
    }

    const compression = opts?.compression ?? "zstd";
    const helperImage = compression === "zstd" ? "alpine:3" : HELPER_IMAGE;
    await this.ensureImage(helperImage);

    const clearCmd = opts?.clearTarget
      ? `find /mnt -mindepth 1 -delete 2>/dev/null || true; `
      : "";
    const untarCmd =
      compression === "zstd"
        ? `${clearCmd}zstd -d -c | tar -x -C /mnt`
        : `${clearCmd}tar -x${compressionFlag(compression)}f - -C /mnt`;

    const helper = await this.dockerode.createContainer({
      Image: helperImage,
      Cmd: [
        "sh",
        "-c",
        compression === "zstd"
          ? `apk add --no-cache zstd >/dev/null 2>&1; ${untarCmd}`
          : untarCmd,
      ],
      HostConfig: { Binds: [`${source.source}:/mnt`], AutoRemove: true },
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      NetworkDisabled: true,
    });

    const stream = await helper.attach({
      stream: true,
      hijack: true,
      stdin: true,
      stdout: true,
      stderr: true,
    });
    await helper.start();

    let bytesWritten = 0;
    body.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });
    body.pipe(stream);

    const waitResult = await helper.wait();
    if (waitResult.StatusCode !== 0) {
      throw new Error(`Restore helper exited with code ${waitResult.StatusCode}`);
    }
    return { bytesWritten };
  }

  async pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo> {
    if (!service.containerId) {
      throw new Error(
        `Cannot exec in service ${service.name}: no containerId. Service must be deployed.`,
      );
    }
    const container = this.dockerode.getContainer(service.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      User: opts?.user,
      WorkingDir: opts?.cwd,
      Env: opts?.env
        ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    // Capture stderr while we write to stdin. dockerode demuxes the
    // hijacked stream — both stdout and stderr come back framed. We
    // collect a bounded tail for diagnostics; stdout is discarded
    // because restore commands typically log to stderr.
    const stderrChunks: Buffer[] = [];
    const { PassThrough } = await import("node:stream");
    const stdoutSink = new PassThrough();
    stdoutSink.resume();
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    this.dockerode.modem.demuxStream(
      stream as unknown as NodeJS.ReadableStream,
      stdoutSink,
      stderrSink,
    );

    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          try {
            (stream as unknown as { end?: () => void }).end?.();
          } catch {
            // best-effort
          }
        }, opts.timeoutMs)
      : null;

    return new Promise<ExecExitInfo>((resolve, reject) => {
      body.on("error", (err) => {
        if (timer) clearTimeout(timer);
        try {
          (stream as unknown as { end?: () => void }).end?.();
        } catch {
          // best-effort
        }
        reject(err);
      });
      stream.on("end", async () => {
        if (timer) clearTimeout(timer);
        try {
          const info = await this.dockerode.getExec(exec.id).inspect();
          resolve({
            code: info.ExitCode ?? 0,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        } catch (err) {
          reject(err);
        }
      });
      stream.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      // Pipe body → stdin. ssh2/dockerode hijack streams are
      // bidirectional; writing to it = stdin, reading = stdout/stderr
      // (demuxed above).
      body.pipe(stream as unknown as NodeJS.WritableStream);
    });
  }

  async stopService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) return;
    try {
      await this.dockerode.getContainer(service.containerId).stop({ t: 30 });
    } catch {
      // Already stopped or gone — idempotent.
    }
  }

  async startService(service: ServiceHandle): Promise<void> {
    if (!service.containerId) {
      throw new Error(`Cannot start service ${service.name}: no containerId`);
    }
    try {
      await this.dockerode.getContainer(service.containerId).start();
    } catch (err: unknown) {
      // Already running is fine.
      const e = err as { statusCode?: number };
      if (e?.statusCode !== 304) throw err;
    }
  }

  async isRunning(service: ServiceHandle): Promise<boolean> {
    if (!service.containerId) return false;
    try {
      const data = await this.dockerode.getContainer(service.containerId).inspect();
      return !!data.State?.Running;
    } catch {
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.dockerode.getImage(image).inspect();
    } catch {
      // Pull synchronously — alpine:3 is tiny (~3 MB).
      const stream = await this.dockerode.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.dockerode.modem.followProgress(stream, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    }
  }

  /** dockerode `exec.start` returns a multiplexed stream — stdout +
   *  stderr interleaved with frame headers. demux into clean streams. */
  private attachDemuxed(
    docker: Dockerode,
    execId: string,
    stream: NodeJS.ReadWriteStream,
    timeoutMs: number | undefined,
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const stdout = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });

    docker.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink);

    const awaitExit = new Promise<ExecExitInfo>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            stdout.destroy(new Error(`exec timed out after ${timeoutMs}ms`));
            reject(new Error(`exec timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      stream.on("end", async () => {
        if (timer) clearTimeout(timer);
        try {
          const info = await docker.getExec(execId).inspect();
          resolve({
            code: info.ExitCode ?? 0,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        } catch (err) {
          reject(err);
        }
      });
      stream.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });

    return { stdout, awaitExit };
  }

  private demuxContainerStream(
    container: Dockerode.Container,
    stream: NodeJS.ReadWriteStream,
    timeoutMs: number | undefined,
  ): { stdout: Readable; awaitExit: Promise<ExecExitInfo> } {
    const stdout = new PassThrough();
    const stderrChunks: Buffer[] = [];
    const stderrSink = new PassThrough();
    stderrSink.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    container.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderrSink);

    const awaitExit = new Promise<ExecExitInfo>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            stdout.destroy(new Error(`helper container timed out after ${timeoutMs}ms`));
            reject(new Error(`helper container timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      container
        .wait()
        .then((res) => {
          if (timer) clearTimeout(timer);
          resolve({
            code: res.StatusCode,
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 16 * 1024),
          });
        })
        .catch((err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });
    });

    return { stdout, awaitExit };
  }
}

// ─── Self-registration ───────────────────────────────────────────────────────

registerExecutor("docker", (runtime) => {
  if (!(runtime instanceof DockerRuntime)) {
    throw new Error(
      "DockerBackupExecutor requires a DockerRuntime instance. " +
        `Got: ${(runtime as { name?: string })?.name ?? typeof runtime}`,
    );
  }
  return new DockerBackupExecutor(runtime);
});
