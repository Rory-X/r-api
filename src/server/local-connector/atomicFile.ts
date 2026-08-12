import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_CONNECTOR_MANAGED_FILE_BYTES = 2 * 1024 * 1024;

export type OptionalFileSnapshot = {
  exists: boolean;
  data: Buffer;
  mode: number | null;
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function assertRegularFile(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`拒绝操作符号链接: ${path}`);
    if (!stat.isFile()) throw new Error(`目标不是普通文件: ${path}`);
    return stat;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function readOptionalFile(
  path: string,
  maxBytes = MAX_CONNECTOR_MANAGED_FILE_BYTES,
): Promise<OptionalFileSnapshot> {
  const stat = await assertRegularFile(path);
  if (!stat) return { exists: false, data: Buffer.alloc(0), mode: null };
  if (stat.size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节限制: ${path}`);
  const handle = await open(path, constants.O_RDONLY);
  try {
    const data = await handle.readFile();
    if (data.byteLength > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节限制: ${path}`);
    return { exists: true, data, mode: Number(stat.mode) & 0o777 };
  } finally {
    await handle.close();
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
  }

  const displaced = `${target}.metapi-displaced-${randomUUID()}`;
  let displacedExisting = false;
  try {
    await rename(target, displaced);
    displacedExisting = true;
    await rename(source, target);
    await rm(displaced, { force: true });
  } catch (error) {
    if (displacedExisting) await rename(displaced, target).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteFile(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertRegularFile(path);
  const tempPath = join(parent, `.${randomUUID()}.metapi-tmp`);
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    await replaceFile(tempPath, path);
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicRemoveFile(path: string): Promise<boolean> {
  const stat = await assertRegularFile(path);
  if (!stat) return false;
  const displaced = `${path}.metapi-remove-${randomUUID()}`;
  await rename(path, displaced);
  await rm(displaced, { force: true });
  return true;
}
