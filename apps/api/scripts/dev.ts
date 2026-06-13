import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "local" | "saas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function parseMode(value: string | undefined): Mode {
  return value === "saas" ? "saas" : "local";
}

/**
 * Best-effort `.env` peek so the dev script can know whether a var is
 * ALREADY pinned by the operator. We need this because Node's
 * `--env-file` doesn't override existing process.env entries — so if
 * we blindly add defaults at spawn time, they win over .env. By
 * reading .env first we can defer to whatever the operator pinned and
 * only inject defaults when the file is silent.
 */
function readEnvKeys(envFile: string): Set<string> {
  const filePath = path.join(appRoot, envFile);
  if (!existsSync(filePath)) return new Set();
  try {
    const raw = readFileSync(filePath, "utf-8");
    const keys = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key) keys.add(key);
    }
    return keys;
  } catch {
    return new Set();
  }
}

function getConfig(mode: Mode) {
  if (mode === "saas") {
    return {
      envFile: ".env.saas",
      env: {
        NODE_ENV: "development",
        CLOUD_MODE: "true",
        DEPLOY_MODE: "cloud",
        PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? path.join(homedir(), ".openship", "data-saas"),
      },
    };
  }

  // Local self-hosted dev. When the operator is ALSO running `bun dev:saas`
  // on the same machine (the standard dual-dev setup), the local API
  // should talk to the local SaaS on :4100 — not `api.openship.io`,
  // which would reject the auth codes minted by the local SaaS with 401.
  //
  // We only INJECT these defaults when neither the operator's shell
  // (process.env) nor their .env file already pins them. This way a
  // real self-hosted user who explicitly sets CLOUD_API_URL in .env to
  // point at production gets their value respected.
  const envFile = ".env";
  const pinnedKeys = readEnvKeys(envFile);

  const env: Record<string, string> = {
    NODE_ENV: "development",
    CLOUD_MODE: "false",
  };
  if (!process.env.CLOUD_API_URL && !pinnedKeys.has("CLOUD_API_URL")) {
    env.CLOUD_API_URL = "http://localhost:4100";
  }
  if (
    !process.env.CLOUD_DASHBOARD_URL &&
    !pinnedKeys.has("CLOUD_DASHBOARD_URL")
  ) {
    env.CLOUD_DASHBOARD_URL = "http://localhost:3002";
  }

  return { envFile, env };
}

const mode = parseMode(process.argv[2]);
const config = getConfig(mode);

const child = spawn(
  "node",
  ["--env-file", config.envFile, "--import", "tsx", "--watch", "src/index.ts"],
  {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...config.env,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
