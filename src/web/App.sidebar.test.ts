import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App sidebar config', () => {
  it('uses 渠道管理 as the single upstream entry and removes standalone token navigation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain("{ to: '/channels', label: '渠道管理'");
    expect(source).not.toContain("{ to: '/accounts', label: '连接管理'");
    expect(source).not.toContain("{ to: '/tokens', label: '令牌管理'");
  });

  it('places downstream key navigation under 路由与运行 instead of 系统', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const runtimeGroupIndex = source.indexOf("label: '路由与运行'");
    const downstreamIndex = source.indexOf("{ to: '/downstream-keys', label: '下游密钥'");
    const systemGroupIndex = source.indexOf("label: '系统与安全'");

    expect(runtimeGroupIndex).toBeGreaterThanOrEqual(0);
    expect(downstreamIndex).toBeGreaterThan(runtimeGroupIndex);
    expect(systemGroupIndex).toBeGreaterThan(downstreamIndex);
  });

  it('keeps the official pool independent and places the safety vault under 系统与安全', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const accessGroupIndex = source.indexOf("label: '接入管理'");
    const runtimeGroupIndex = source.indexOf("label: '路由与运行'");
    const systemGroupIndex = source.indexOf("label: '系统与安全'");
    const accessGroup = source.slice(accessGroupIndex, runtimeGroupIndex);
    const systemGroup = source.slice(systemGroupIndex, source.indexOf('];', systemGroupIndex));

    expect(accessGroup).toContain("{ to: '/official-credentials', label: '官方凭证池'");
    expect(accessGroup).not.toContain("label: '安全凭证库'");
    expect(systemGroup).toContain("{ to: '/settings/credentials', label: '安全凭证库'");
    expect(source).toContain('<Route path="/settings/credentials" element={<CredentialVault />} />');
    expect(source).toContain('<Route path="credentials" element={<PreservingRedirect pathname="/settings/credentials" />} />');
    expect(source).toContain('<Route path="/credential-vault" element={<PreservingRedirect pathname="/settings/credentials" />} />');
  });

  it('orders routing and runtime navigation by workflow priority', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const runtimeGroupIndex = source.indexOf("label: '路由与运行'");
    const systemGroupIndex = source.indexOf("label: '系统与安全'", runtimeGroupIndex);
    const runtimeGroup = source.slice(runtimeGroupIndex, systemGroupIndex);

    const orderedEntries = [
      "{ to: '/routes', label: '路由'",
      "{ to: '/downstream-keys', label: '下游密钥'",
      "{ to: '/logs', label: '使用日志'",
      "{ to: '/checkin', label: '签到记录'",
      "{ to: '/monitor', label: '可用性监控'",
    ];
    const entryIndexes = orderedEntries.map((entry) => runtimeGroup.indexOf(entry));

    expect(runtimeGroupIndex).toBeGreaterThanOrEqual(0);
    expect(systemGroupIndex).toBeGreaterThan(runtimeGroupIndex);
    expect(entryIndexes.every((index) => index >= 0)).toBe(true);
    expect(entryIndexes).toEqual([...entryIndexes].sort((left, right) => left - right));
  });

  it('keeps the old upstream routes as compatibility redirects', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const accessGroupIndex = source.indexOf("label: '接入管理'");
    const runtimeGroupIndex = source.indexOf("label: '路由与运行'");

    expect(accessGroupIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain('function LegacyChannelRedirect');
    expect(source).toContain('<Route path="/sites" element={<LegacyChannelRedirect section="sites" />} />');
    expect(source).toContain('<Route path="/accounts" element={<LegacyChannelRedirect section="connections" />} />');
    expect(source).toContain('<Route path="/oauth" element={<PreservingRedirect pathname="/official-credentials" />} />');
    expect(source).toContain('<Route path="/official-credentials" element={<OfficialCredentialPool />} />');
    expect(runtimeGroupIndex).toBeGreaterThan(accessGroupIndex);
  });

  it('mounts only upstream workflows below /channels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain("const ChannelManagement = lazy(() => import('./pages/ChannelManagement.js'));");
    expect(source).toContain('<Route path="/channels" element={<ChannelManagement />}>');
    expect(source).toContain('<Route path="sites" element={<Sites />} />');
    expect(source).toContain('<Route path="connections" element={<Accounts />} />');
    expect(source).toContain('<Route path="oauth" element={<PreservingRedirect pathname="/official-credentials" />} />');
    expect(source).not.toContain('<Route path="oauth" element={<OfficialCredentialPool />} />');
    expect(source).not.toContain('<Route path="credentials" element={<CredentialVault />} />');
    expect(source).toContain('<Route path="credentials" element={<PreservingRedirect pathname="/settings/credentials" />} />');
    expect(source).toContain('<Route path="recovery" element={<BrowserRecoveryTasks />} />');
  });
});
