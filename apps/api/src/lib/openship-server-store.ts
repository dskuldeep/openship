/**
 * The single owner of the `/root/.openship/` folder on a target server.
 *
 * Everything Openship persists ON a server (mail state, the project manifest)
 * lives in this one root-only directory so it's the server's self-describing
 * source of truth — survive-the-orchestrator state for disaster recovery.
 *
 * This module owns ONLY the storage mechanics: ensuring the folder exists and
 * atomic file read/write/remove over an SSH `CommandExecutor`. Domain modules
 * (`mail-state.ts`, `openship-manifest.ts`) layer their schemas on top and must
 * NOT re-implement the folder/mkdir/atomic-write logic — call these helpers.
 */

import type { CommandExecutor } from "@repo/adapters";

/** The one folder. Nothing else hard-codes this path. */
export const OPENSHIP_DIR = "/root/.openship";

/**
 * Ensure the `.openship` dir exists, root-only (0700). Idempotent. THE single
 * place the folder is created — callers never `mkdir` it themselves.
 */
export async function ensureOpenshipDir(exec: CommandExecutor): Promise<void> {
  await exec.exec(`mkdir -p ${OPENSHIP_DIR} && chmod 0700 ${OPENSHIP_DIR}`);
}

/**
 * Read a file from `.openship` by bare name (e.g. "mail-state.json"). Returns
 * "" when absent — never throws on a missing file.
 */
export async function readOpenshipFile(exec: CommandExecutor, name: string): Promise<string> {
  const path = `${OPENSHIP_DIR}/${name}`;
  try {
    return (await exec.exec(`cat ${path} 2>/dev/null || echo ""`)).trim();
  } catch {
    return "";
  }
}

/**
 * Atomically write a file into `.openship` (temp file → `mv -f`), root-only
 * (0600). Ensures the dir first. A kill mid-write never leaves a partial file.
 */
export async function writeOpenshipFile(
  exec: CommandExecutor,
  name: string,
  content: string,
): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  const tmp = `${path}.tmp`;
  await ensureOpenshipDir(exec);
  await exec.writeFile(tmp, content);
  await exec.exec(`mv -f ${tmp} ${path} && chmod 0600 ${path}`);
}

/** Remove a file (and any stale temp) from `.openship`. Idempotent. */
export async function removeOpenshipFile(exec: CommandExecutor, name: string): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  await exec.exec(`rm -f ${path} ${path}.tmp`);
}
