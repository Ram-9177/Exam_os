import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface StoragePutResult {
  blobRef: string;
  sha256: string;
  byteLength: number;
}

export interface DocumentStorage {
  putObject(tenantId: string, bucket: string, key: string, data: Buffer, contentType: string): Promise<StoragePutResult>;
  getObject(tenantId: string, bucket: string, key: string): Promise<{ data: Buffer; contentType: string } | null>;
  hasObject(tenantId: string, bucket: string, key: string): Promise<boolean>;
}

export class LocalFileDocumentStorage implements DocumentStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.env['STORAGE_DIR'] ?? path.resolve(process.cwd(), '.storage');
  }

  private resolvePath(tenantId: string, bucket: string, key: string): string {
    // Sanitize key to prevent path traversal
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.baseDir, bucket, tenantId, safeKey);
  }

  async putObject(tenantId: string, bucket: string, key: string, data: Buffer, contentType: string): Promise<StoragePutResult> {
    const filePath = this.resolvePath(tenantId, bucket, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);

    const metaPath = `${filePath}.meta.json`;
    const sha256 = createHash('sha256').update(data).digest('hex');
    await fs.writeFile(metaPath, JSON.stringify({ contentType, sha256, byteLength: data.length, createdAt: new Date().toISOString() }));

    const blobRef = `local://${bucket}/${tenantId}/${key}`;
    return {
      blobRef,
      sha256,
      byteLength: data.length,
    };
  }

  async getObject(tenantId: string, bucket: string, key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const filePath = this.resolvePath(tenantId, bucket, key);
    try {
      const data = await fs.readFile(filePath);
      let contentType = 'application/pdf';
      try {
        const meta = JSON.parse(await fs.readFile(`${filePath}.meta.json`, 'utf8')) as { contentType?: string };
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        // default fallback
      }
      return { data, contentType };
    } catch {
      return null;
    }
  }

  async hasObject(tenantId: string, bucket: string, key: string): Promise<boolean> {
    const filePath = this.resolvePath(tenantId, bucket, key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

let defaultStorage: DocumentStorage | null = null;

export function getDocumentStorage(): DocumentStorage {
  if (!defaultStorage) {
    defaultStorage = new LocalFileDocumentStorage();
  }
  return defaultStorage;
}

export function setDocumentStorage(storage: DocumentStorage): void {
  defaultStorage = storage;
}

