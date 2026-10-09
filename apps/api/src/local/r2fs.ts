// R2Adapter over the local filesystem (./data/r2/<key>). Local-dev binding.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { R2Adapter, R2GetResult } from '../lib/r2.js';

function safeKey(root: string, key: string): string {
  const p = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(root, p);
}

export class FsR2Adapter implements R2Adapter {
  constructor(private root: string) {}

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer, opts?: { contentType?: string }): Promise<void> {
    const file = safeKey(this.root, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (body instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await fs.writeFile(file, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    } else {
      await fs.writeFile(file, Buffer.from(body as Uint8Array));
    }
    if (opts?.contentType) {
      await fs.writeFile(file + '.meta.json', JSON.stringify({ contentType: opts.contentType }));
    }
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<R2GetResult | null> {
    const file = safeKey(this.root, key);
    let stat;
    try { stat = await fs.stat(file); } catch { return null; }
    if (!stat.isFile()) return null;
    const size = stat.size;
    const start = range?.offset ?? 0;
    const end = range?.length != null ? Math.min(size, start + range.length) : size;
    const fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(Math.max(0, end - start));
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    const meta = await this.meta(file);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(buf)); controller.close(); },
    });
    return {
      body: stream, size, contentType: meta?.contentType,
      range: range ? { start, end: end - 1 } : undefined,
    };
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    const file = safeKey(this.root, key);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      const meta = await this.meta(file);
      return { size: stat.size, contentType: meta?.contentType };
    } catch { return null; }
  }

  async delete(key: string): Promise<void> {
    const file = safeKey(this.root, key);
    await fs.rm(file, { force: true });
    await fs.rm(file + '.meta.json', { force: true });
  }

  private async meta(file: string): Promise<{ contentType?: string } | null> {
    try {
      return JSON.parse(await fs.readFile(file + '.meta.json', 'utf8'));
    } catch { return null; }
  }
}
