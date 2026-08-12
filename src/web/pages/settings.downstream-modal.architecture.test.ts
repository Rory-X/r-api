import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Settings downstream credential ownership', () => {
  it('keeps downstream credentials out of Settings and delegates them to the downstream key workspace', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const downstreamSource = readFileSync(resolve(process.cwd(), 'src/web/pages/DownstreamKeys.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const globalTokenSource = readFileSync(resolve(process.cwd(), 'src/web/pages/downstream-keys/GlobalProxyTokenCard.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).not.toContain("import DownstreamApiKeyModal from './settings/DownstreamApiKeyModal.js'");
    expect(source).not.toContain('downstreamModalOpen');
    expect(source).not.toContain('downstreamCreate');
    expect(source).not.toContain('下游访问令牌（PROXY_TOKEN）');
    expect(source).not.toContain('saveProxyToken');
    expect(downstreamSource).toContain("import GlobalProxyTokenCard from './downstream-keys/GlobalProxyTokenCard.js'");
    expect(downstreamSource).toContain('<GlobalProxyTokenCard />');
    expect(globalTokenSource).toContain('全局主密钥');
    expect(globalTokenSource).toContain('完整权限');
    expect(globalTokenSource).toContain('新项目建议使用下方项目密钥');
  });
});
