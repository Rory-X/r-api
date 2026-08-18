import { describe, expect, it } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { pack as packTar } from 'it-tar';
import {
  collectOauthImportDropFiles,
  readOauthImportDrafts,
  type OAuthImportFileLike,
} from './credentialImportSources.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildFile(
  name: string,
  content: string | Uint8Array,
  options: { relativePath?: string } = {},
): OAuthImportFileLike {
  const bytes = typeof content === 'string' ? strToU8(content) : content;
  return {
    name,
    size: bytes.byteLength,
    webkitRelativePath: options.relativePath,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => toArrayBuffer(bytes),
  };
}

async function buildTar(entries: Record<string, string>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const source = Object.entries(entries).map(([name, body]) => ({ header: { name }, body }));
  for await (const chunk of packTar()(source)) {
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe('official credential import sources', () => {
  it('reads a selected auth directory recursively and ignores non-json files', async () => {
    const drafts = await readOauthImportDrafts([
      buildFile('codex.json', '{"type":"codex","access_token":"token-a"}', {
        relativePath: 'auth-dir/team/codex.json',
      }),
      buildFile('README.txt', 'ignored', { relativePath: 'auth-dir/README.txt' }),
      buildFile('.DS_Store', 'ignored', { relativePath: 'auth-dir/.DS_Store' }),
    ]);

    expect(drafts).toEqual([{
      sourceName: 'auth-dir/team/codex.json',
      rawText: '{"type":"codex","access_token":"token-a"}',
    }]);
  });

  it('extracts nested json credentials from zip archives', async () => {
    const archive = zipSync({
      'auth-dir/codex.json': strToU8('{"type":"codex","access_token":"zip-token"}'),
      'auth-dir/README.txt': strToU8('ignored'),
    });

    const drafts = await readOauthImportDrafts([buildFile('cpa-auth.zip', archive)]);

    expect(drafts).toEqual([{
      sourceName: 'cpa-auth.zip/auth-dir/codex.json',
      rawText: '{"type":"codex","access_token":"zip-token"}',
    }]);
  });

  it.each([
    ['tar', 'cpa-auth.tar', false],
    ['tar.gz', 'cpa-auth.tar.gz', true],
    ['tgz', 'cpa-auth.tgz', true],
  ])('extracts json credentials from %s archives', async (_label, name, gzip) => {
    const tar = await buildTar({
      'auth-dir/claude.json': '{"type":"claude","access_token":"tar-token"}',
      'auth-dir/notes.txt': 'ignored',
    });
    const archive = gzip ? gzipSync(tar) : tar;

    const drafts = await readOauthImportDrafts([buildFile(name, archive)]);

    expect(drafts).toEqual([{
      sourceName: `${name}/auth-dir/claude.json`,
      rawText: '{"type":"claude","access_token":"tar-token"}',
    }]);
  });

  it('recursively collects files from a dragged directory entry', async () => {
    const codexFile = buildFile('codex.json', '{"type":"codex","access_token":"drop-token"}');
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: 'codex.json',
      file: (success: (file: OAuthImportFileLike) => void) => success(codexFile),
    };
    let readCount = 0;
    const nestedDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'team',
      createReader: () => ({
        readEntries: (success: (entries: any[]) => void) => {
          readCount += 1;
          success(readCount === 1 ? [fileEntry] : []);
        },
      }),
    };
    let rootReadCount = 0;
    const rootDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'auth-dir',
      createReader: () => ({
        readEntries: (success: (entries: any[]) => void) => {
          rootReadCount += 1;
          success(rootReadCount === 1 ? [nestedDirectory] : []);
        },
      }),
    };

    const files = await collectOauthImportDropFiles({
      items: [{ kind: 'file', webkitGetAsEntry: () => rootDirectory }],
    });
    const drafts = await readOauthImportDrafts(files);

    expect(drafts).toEqual([{
      sourceName: 'auth-dir/team/codex.json',
      rawText: '{"type":"codex","access_token":"drop-token"}',
    }]);
  });

  it('reports archives that contain no credential json', async () => {
    const archive = zipSync({ 'README.txt': strToU8('nothing to import') });
    const drafts = await readOauthImportDrafts([buildFile('empty.zip', archive)]);

    expect(drafts).toEqual([{
      sourceName: 'empty.zip',
      rawText: '',
      error: '压缩包中没有找到可导入的 JSON 凭证',
    }]);
  });
});
