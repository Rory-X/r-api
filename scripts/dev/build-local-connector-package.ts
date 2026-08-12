import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = process.cwd();
const sourceDir = resolve(root, 'dist/server/local-connector');
const packageDir = resolve(root, 'packages/metapi-connector');
const outputDir = join(packageDir, 'dist');

const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
  name?: string;
  version?: string;
};
const identitySource = await readFile(resolve(root, 'src/server/local-connector/identity.ts'), 'utf8');
const sourceVersion = identitySource.match(/CONNECTOR_VERSION = '([^']+)'/)?.[1] || null;
if (!manifest.name || !manifest.version || manifest.version !== sourceVersion) {
  throw new Error(`Connector package version mismatch: package=${manifest.version || '-'} source=${sourceVersion || '-'}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, {
  recursive: true,
  filter: (path) => !basename(path).includes('.test.'),
});

const entry = await readFile(join(outputDir, 'cli.js'), 'utf8');
if (!entry.startsWith('#!/usr/bin/env node')) {
  throw new Error('Connector package CLI entry is missing its node shebang');
}
process.stdout.write(`Built ${manifest.name}@${manifest.version} in ${outputDir}\n`);
