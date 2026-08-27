import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    digest.update(buffer);
  }
  return { bytes, sha256: digest.digest('hex') };
}
