import { describe, expect, test } from "vitest";
import { createServer } from "node:net";
import { probeTcp } from "./reachability";

/** Bind a throwaway TCP server on an ephemeral port and return {port, close}. */
async function listenEphemeral(): Promise<{ port: number; close: () => void }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return { port: address.port, close: () => server.close() };
}

describe("probeTcp", () => {
  test("resolves true when the port is accepting connections", async () => {
    const { port, close } = await listenEphemeral();
    try {
      expect(await probeTcp("127.0.0.1", port, 1000)).toBe(true);
    } finally {
      close();
    }
  });

  test("resolves false when nothing is listening (connection refused)", async () => {
    // Bind then immediately close to get a port that's free right now.
    const { port, close } = await listenEphemeral();
    close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await probeTcp("127.0.0.1", port, 1000)).toBe(false);
  });

  test("resolves false (never throws) on an unroutable host within the timeout", async () => {
    // TEST-NET-1 (192.0.2.0/24, RFC 5737) is guaranteed non-routable — the
    // connect stalls and must hit our timeout, resolving false rather than hanging.
    const start = Date.now();
    const result = await probeTcp("192.0.2.1", 22, 600);
    expect(result).toBe(false);
    // Bounded by the timeout, not the OS default (~20s+).
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
