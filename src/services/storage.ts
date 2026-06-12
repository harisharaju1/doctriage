import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

const UPLOAD_DIR = path.resolve('uploads');

export function getUploadPath(documentId: string): string {
  return path.join(UPLOAD_DIR, `${documentId}.pdf`);
}

export async function saveUpload(documentId: string, fileStream: Readable): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = getUploadPath(documentId);
  await pipeline(fileStream, createWriteStream(filePath));
  return filePath;
}

export async function deleteUpload(documentId: string): Promise<void> {
  await rm(getUploadPath(documentId), { force: true });
}
