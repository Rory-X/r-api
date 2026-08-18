import { gunzipSync, unzipSync } from 'fflate';
import { extract as extractTar } from 'it-tar';

const MAX_IMPORT_JSON_FILES = 500;
const MAX_JSON_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 20;

export type OAuthImportFileLike = {
  name?: string;
  size?: number;
  type?: string;
  webkitRelativePath?: string;
  importRelativePath?: string;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type OAuthImportDraft = {
  sourceName: string;
  rawText: string;
  error?: string;
};

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
};

type FileSystemDirectoryReaderLike = {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    failure?: (error: unknown) => void,
  ) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => FileSystemDirectoryReaderLike;
};

type DataTransferItemLike = {
  kind?: string;
  getAsFile?: () => File | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

export type OAuthImportDataTransferLike = {
  files?: ArrayLike<OAuthImportFileLike> | null;
  items?: ArrayLike<DataTransferItemLike> | null;
};

type ImportBudget = {
  jsonCount: number;
  totalJsonBytes: number;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeSourcePath(value: string): string {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/');
}

function resolveFileSourceName(file: OAuthImportFileLike, index: number): string {
  return normalizeSourcePath(
    file.importRelativePath
      || file.webkitRelativePath
      || file.name
      || `oauth-import-${index + 1}.json`,
  );
}

function shouldIgnorePath(path: string): boolean {
  const parts = normalizeSourcePath(path).split('/');
  return parts.some((part) => part === '__MACOSX' || part.startsWith('.'));
}

function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith('.json');
}

function resolveArchiveKind(path: string): 'zip' | 'tar' | 'tar-gzip' | null {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.tar.gz') || normalized.endsWith('.tgz')) return 'tar-gzip';
  if (normalized.endsWith('.zip')) return 'zip';
  if (normalized.endsWith('.tar')) return 'tar';
  return null;
}

function reserveJson(budget: ImportBudget, sourceName: string, byteLength: number): void {
  if (byteLength > MAX_JSON_FILE_BYTES) {
    throw new Error(`${sourceName} 超过单个 JSON 2 MB 限制`);
  }
  if (budget.jsonCount + 1 > MAX_IMPORT_JSON_FILES) {
    throw new Error(`凭证 JSON 数量超过 ${MAX_IMPORT_JSON_FILES} 份限制`);
  }
  if (budget.totalJsonBytes + byteLength > MAX_TOTAL_JSON_BYTES) {
    throw new Error('凭证 JSON 总大小超过 20 MB 限制');
  }
  budget.jsonCount += 1;
  budget.totalJsonBytes += byteLength;
}

function decodeJsonBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readFileBytes(file: OAuthImportFileLike, sourceName: string): Promise<Uint8Array> {
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`${sourceName} 超过压缩包 25 MB 限制`);
  }
  if (typeof file.arrayBuffer !== 'function') {
    throw new Error(`${sourceName} 无法读取二进制内容`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`${sourceName} 超过压缩包 25 MB 限制`);
  }
  return bytes;
}

async function readPlainJsonDraft(
  file: OAuthImportFileLike,
  sourceName: string,
  budget: ImportBudget,
): Promise<OAuthImportDraft> {
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_FILE_BYTES) {
    throw new Error(`${sourceName} 超过单个 JSON 2 MB 限制`);
  }
  let rawText: string;
  if (typeof file.text === 'function') {
    rawText = await file.text();
  } else if (typeof file.arrayBuffer === 'function') {
    rawText = decodeJsonBytes(new Uint8Array(await file.arrayBuffer()));
  } else {
    throw new Error(`${sourceName} 无法读取文件内容`);
  }
  const byteLength = new TextEncoder().encode(rawText).byteLength;
  reserveJson(budget, sourceName, byteLength);
  return { sourceName, rawText };
}

function extractZipDrafts(
  archiveName: string,
  bytes: Uint8Array,
  budget: ImportBudget,
): OAuthImportDraft[] {
  let expandedBytes = 0;
  let jsonCount = 0;
  const extracted = unzipSync(bytes, {
    filter: (entry) => {
      const entryName = normalizeSourcePath(entry.name);
      if (!entryName || shouldIgnorePath(entryName) || !isJsonPath(entryName)) return false;
      if (entry.originalSize > MAX_JSON_FILE_BYTES) {
        throw new Error(`${archiveName}/${entryName} 超过单个 JSON 2 MB 限制`);
      }
      expandedBytes += entry.originalSize;
      jsonCount += 1;
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        throw new Error(`${archiveName} 解压后的 JSON 超过 50 MB 限制`);
      }
      if (jsonCount > MAX_IMPORT_JSON_FILES) {
        throw new Error(`${archiveName} 内的 JSON 数量超过 ${MAX_IMPORT_JSON_FILES} 份限制`);
      }
      return true;
    },
  });

  return Object.entries(extracted).map(([entryPath, entryBytes]) => {
    const sourceName = `${archiveName}/${normalizeSourcePath(entryPath)}`;
    reserveJson(budget, sourceName, entryBytes.byteLength);
    return { sourceName, rawText: decodeJsonBytes(entryBytes) };
  });
}

async function extractTarDrafts(
  archiveName: string,
  bytes: Uint8Array,
  budget: ImportBudget,
): Promise<OAuthImportDraft[]> {
  if (bytes.byteLength > MAX_ARCHIVE_EXPANDED_BYTES) {
    throw new Error(`${archiveName} 解压后超过 50 MB 限制`);
  }

  const drafts: OAuthImportDraft[] = [];
  let expandedJsonBytes = 0;
  for await (const entry of extractTar()([bytes])) {
    const entryName = normalizeSourcePath(entry.header.name || '');
    const shouldRead = entry.header.type !== 'directory'
      && !!entryName
      && !shouldIgnorePath(entryName)
      && isJsonPath(entryName);

    if (!shouldRead) {
      for await (const _chunk of entry.body) {
        // Drain the entry so the TAR parser can advance to the next header.
      }
      continue;
    }

    const sourceName = `${archiveName}/${entryName}`;
    if (entry.header.size > MAX_JSON_FILE_BYTES) {
      throw new Error(`${sourceName} 超过单个 JSON 2 MB 限制`);
    }
    expandedJsonBytes += entry.header.size;
    if (expandedJsonBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`${archiveName} 解压后的 JSON 超过 50 MB 限制`);
    }

    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    for await (const chunk of entry.body) {
      totalLength += chunk.byteLength;
      if (totalLength > MAX_JSON_FILE_BYTES) {
        throw new Error(`${sourceName} 超过单个 JSON 2 MB 限制`);
      }
      chunks.push(chunk);
    }
    const entryBytes = concatBytes(chunks, totalLength);
    reserveJson(budget, sourceName, entryBytes.byteLength);
    drafts.push({ sourceName, rawText: decodeJsonBytes(entryBytes) });
  }
  return drafts;
}

async function readArchiveDrafts(
  file: OAuthImportFileLike,
  archiveName: string,
  archiveKind: NonNullable<ReturnType<typeof resolveArchiveKind>>,
  budget: ImportBudget,
): Promise<OAuthImportDraft[]> {
  const archiveBytes = await readFileBytes(file, archiveName);
  if (archiveKind === 'zip') {
    return extractZipDrafts(archiveName, archiveBytes, budget);
  }
  const tarBytes = archiveKind === 'tar-gzip' ? gunzipSync(archiveBytes) : archiveBytes;
  if (tarBytes.byteLength > MAX_ARCHIVE_EXPANDED_BYTES) {
    throw new Error(`${archiveName} 解压后超过 50 MB 限制`);
  }
  return await extractTarDrafts(archiveName, tarBytes, budget);
}

export async function readOauthImportDrafts(
  files: ArrayLike<OAuthImportFileLike> | null | undefined,
): Promise<OAuthImportDraft[]> {
  const nextFiles = files ? Array.from(files) : [];
  const budget: ImportBudget = { jsonCount: 0, totalJsonBytes: 0 };
  const drafts: OAuthImportDraft[] = [];

  for (let index = 0; index < nextFiles.length; index += 1) {
    const file = nextFiles[index]!;
    const sourceName = resolveFileSourceName(file, index);
    if (!sourceName || shouldIgnorePath(sourceName)) continue;
    const archiveKind = resolveArchiveKind(sourceName);
    if (!archiveKind && !isJsonPath(sourceName)) continue;

    try {
      if (archiveKind) {
        const archiveDrafts = await readArchiveDrafts(file, sourceName, archiveKind, budget);
        if (archiveDrafts.length === 0) {
          drafts.push({
            sourceName,
            rawText: '',
            error: '压缩包中没有找到可导入的 JSON 凭证',
          });
        } else {
          drafts.push(...archiveDrafts);
        }
      } else {
        drafts.push(await readPlainJsonDraft(file, sourceName, budget));
      }
    } catch (error) {
      drafts.push({
        sourceName,
        rawText: '',
        error: errorMessage(error, '读取凭证来源失败'),
      });
    }
  }

  if (drafts.length === 0 && nextFiles.length > 0) {
    drafts.push({
      sourceName: '所选内容',
      rawText: '',
      error: '没有找到 `.json`、`.zip`、`.tar`、`.tar.gz` 或 `.tgz` 凭证文件',
    });
  }
  return drafts;
}

function readFileEntry(entry: FileSystemFileEntryLike, relativePath: string): Promise<OAuthImportFileLike> {
  return new Promise((resolve, reject) => {
    entry.file((file) => {
      resolve({
        name: file.name,
        size: file.size,
        type: file.type,
        importRelativePath: relativePath,
        text: () => file.text(),
        arrayBuffer: () => file.arrayBuffer(),
      });
    }, reject);
  });
}

function readDirectoryBatch(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function collectEntryFiles(
  entry: FileSystemEntryLike,
  parentPath: string,
  output: OAuthImportFileLike[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new Error(`目录层级超过 ${MAX_DIRECTORY_DEPTH} 层限制`);
  }
  if (output.length >= MAX_IMPORT_JSON_FILES) {
    throw new Error(`目录文件数量超过 ${MAX_IMPORT_JSON_FILES} 份限制`);
  }
  const relativePath = normalizeSourcePath(`${parentPath}/${entry.name}`);
  if (entry.isFile && 'file' in entry) {
    output.push(await readFileEntry(entry as FileSystemFileEntryLike, relativePath));
    return;
  }
  if (!entry.isDirectory || !('createReader' in entry)) return;

  const reader = (entry as FileSystemDirectoryEntryLike).createReader();
  while (true) {
    const entries = await readDirectoryBatch(reader);
    if (entries.length === 0) break;
    for (const child of entries) {
      await collectEntryFiles(child, relativePath, output, depth + 1);
    }
  }
}

export async function collectOauthImportDropFiles(
  dataTransfer: OAuthImportDataTransferLike | null | undefined,
): Promise<OAuthImportFileLike[]> {
  if (!dataTransfer) return [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const output: OAuthImportFileLike[] = [];

  for (const item of items) {
    if (item.kind && item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      await collectEntryFiles(entry, '', output, 0);
      continue;
    }
    const file = item.getAsFile?.();
    if (file) output.push(file);
  }

  if (output.length > 0) return output;
  return dataTransfer.files ? Array.from(dataTransfer.files) : [];
}

export async function readOauthImportDrop(
  dataTransfer: OAuthImportDataTransferLike | null | undefined,
): Promise<OAuthImportDraft[]> {
  const files = await collectOauthImportDropFiles(dataTransfer);
  return await readOauthImportDrafts(files);
}
