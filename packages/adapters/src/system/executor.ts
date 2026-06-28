import type { CommandExecutor, SshConfig } from "../types";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";
import { SystemSshExecutor } from "./system-ssh-executor";

export { wrapLocalBuildCommand } from "./local-shell";
export { LocalExecutor } from "./local-executor";
export { SshExecutor } from "./ssh-executor";
export { SystemSshExecutor } from "./system-ssh-executor";

export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    // "agent" auth routes through the OS `ssh` binary (see SystemSshExecutor);
    // password/key auth use the in-process ssh2 client.
    if (ssh.useSystemSsh) return new SystemSshExecutor(ssh);
    return new SshExecutor(ssh);
  }
  return new LocalExecutor();
}
