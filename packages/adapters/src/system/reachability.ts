import { connect } from "node:net";

/**
 * Cheap TCP liveness probe. Opens a raw socket to `host:port` and resolves
 * `true` if the connection is accepted within `timeoutMs`, `false` otherwise
 * (connection refused, host unreachable, timeout, DNS failure). Never throws;
 * always tears the socket down.
 *
 * This is deliberately independent of the SSH executor (system-ssh agent vs
 * in-process ssh2) — a TCP handshake to the SSH port is the fastest way to
 * decide "is this host answering?" without paying the 15-20s SSH connect
 * timeout that hangs the delete/reconcile paths when a server is down.
 */
export function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean, socket?: ReturnType<typeof connect>) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* already torn down */
      }
      resolve(result);
    };

    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, socket));
    socket.once("timeout", () => done(false, socket));
    socket.once("error", () => done(false, socket));
  });
}
