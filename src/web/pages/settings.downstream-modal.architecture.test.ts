import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Settings downstream credential ownership', () => {
  it('keeps downstream credentials out of Settings and removes the global credential surface', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const downstreamSource = readFileSync(resolve(process.cwd(), 'src/web/pages/DownstreamKeys.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const removedCardPath = resolve(process.cwd(), 'src/web/pages/downstream-keys/GlobalProxyTokenCard.tsx');

    expect(source).not.toContain("import DownstreamApiKeyModal from './settings/DownstreamApiKeyModal.js'");
    expect(source).not.toContain('downstreamModalOpen');
    expect(source).not.toContain('downstreamCreate');
    expect(source).not.toContain('saveProxyToken');
    expect(downstreamSource).not.toContain('GlobalProxyTokenCard');
    expect(downstreamSource).not.toContain('全局主密钥');
    expect(existsSync(removedCardPath)).toBe(false);
  });
});
