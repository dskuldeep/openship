/**
 * Passthrough Transform that computes SHA-256 + byte count of the
 * bytes flowing through it. Used to checksum a backup artifact while
 * it streams from executor → destination without buffering.
 *
 * Usage:
 *   const hasher = new HashingPassthrough();
 *   producerStream.pipe(hasher).pipe(destinationPut);
 *   await destinationPutFinished;
 *   const { sha256, bytesWritten } = hasher.summary();
 */

import { createHash, type Hash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export class HashingPassthrough extends Transform {
  private readonly hash: Hash;
  private bytes = 0;
  private finalDigest: string | null = null;

  constructor() {
    super();
    this.hash = createHash("sha256");
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    this.finalDigest = this.hash.digest("hex");
    cb();
  }

  /** Available after the stream ends (after the `end` event). */
  summary(): { sha256: string; bytesWritten: number } {
    if (this.finalDigest === null) {
      // _flush hasn't run yet. Caller is reading too early.
      throw new Error(
        "HashingPassthrough.summary() called before the stream finished. " +
          "Await the end event first.",
      );
    }
    return { sha256: this.finalDigest, bytesWritten: this.bytes };
  }
}
