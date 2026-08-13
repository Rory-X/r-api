import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from './config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('docs vitepress config', () => {
  it('fails the docs build when an internal link is broken', () => {
    expect(config.ignoreDeadLinks).not.toBe(true);
  });

  it('keeps public navigation focused on user tasks', () => {
    const nav = config.themeConfig?.nav ?? [];
    const serializedNav = JSON.stringify(nav);

    expect(serializedNav).toContain('快速上手');
    expect(serializedNav).toContain('上游渠道接入');
    expect(serializedNav).toContain('官方凭证池');
    expect(serializedNav).toContain('部署与运维');
    expect(serializedNav).not.toContain('文档维护');
  });

  it('keeps core user guides aligned with the current product navigation', () => {
    const coreGuides = [
      'getting-started.md',
      'fork-features-guide.md',
      'upstream-integration.md',
      'configuration.md',
      'faq.md',
      'operations.md',
      'oauth.md',
    ];
    const content = coreGuides
      .map((file) => readFileSync(resolve(repoRoot, 'docs', file), 'utf8'))
      .join('\n');

    expect(content).toContain('渠道管理 → 账号与 API Key');
    expect(content).toContain('官方凭证池');
    expect(content).toContain('系统与安全 → 设置');
    expect(content).not.toMatch(/(?:连接管理|OAuth 管理|TokenRoutes)/);
  });

  it('ships copied main-app favicon assets for docs', () => {
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.png'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon-64.png'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.ico'))).toBe(true);
  });

  it('ships a fallback favicon.ico for browsers that probe the default path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.ico'))).toBe(true);
  });

  it('declares the main-app favicon assets in docs head tags', () => {
    const iconLinks =
      config.head?.filter(
        (entry) =>
          entry[0] === 'link' &&
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          'rel' in entry[1] &&
          (entry[1].rel === 'icon' || entry[1].rel === 'shortcut icon'),
      ) ?? [];

    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon.png')).toBe(true);
    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon-64.png')).toBe(true);
    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon.ico')).toBe(true);
  });
});
