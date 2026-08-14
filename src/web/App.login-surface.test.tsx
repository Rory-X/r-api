import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { Login } from './App.js';
import { SITE_DOCS_URL, SITE_GITHUB_URL } from './docsLink.js';
import { api } from './api.js';

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('Login surface', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the GitHub Pages project site as the documentation URL', () => {
    expect(SITE_DOCS_URL).toBe('https://rory-x.github.io/r-api/');
  });

  it('uses the author github profile for the login github shortcut', () => {
    expect(SITE_GITHUB_URL).toBe('https://github.com/Rory-X/r-api');
  });

  it('renders a poster-style hero with a floating admin login panel', () => {
    const root = create(
      <Login onLogin={vi.fn()} t={(text) => text} />,
    );

    try {
      const pageText = collectText(root.root);
      const lightBrandPanel = root.root.find((node) => (
        node.type === 'section'
        && typeof node.props.className === 'string'
        && node.props.className.includes('login-brand-panel-light')
      ));
      const authStage = root.root.find((node) => (
        node.type === 'section'
        && typeof node.props.className === 'string'
        && node.props.className.includes('login-auth-stage')
      ));
      const brandMarkCanvas = root.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('brand-mark-canvas')
      ));

      expect(pageText).toContain('r-api');
      expect(pageText).toContain('中转站的中转站');
      expect(pageText).not.toContain('一个 API Key，一个入口');
      expect(pageText).toContain('兼容 New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API');
      expect(pageText).toContain('统一代理网关');
      expect(pageText).toContain('智能路由引擎');
      expect(pageText).toContain('自动模型发现');
      expect(pageText).toContain('部署文档');
      expect(lightBrandPanel).toBeTruthy();
      expect(authStage).toBeTruthy();
      expect(brandMarkCanvas).toBeTruthy();

      const docsLink = root.root.find((node) => (
        node.type === 'a'
        && node.props.href === SITE_DOCS_URL
      ));
      const tokenInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '管理员登录凭据'
      ));
      const githubLink = root.root.find((node) => (
        node.type === 'a'
        && node.props.href === SITE_GITHUB_URL
      ));

      expect(docsLink.props.target).toBe('_blank');
      expect(githubLink.props['aria-label']).toBe('GitHub');
      expect(githubLink.props.target).toBe('_blank');
      expect(tokenInput.props.type).toBe('password');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the TOTP challenge in component state until verification succeeds', async () => {
    const onLogin = vi.fn();
    vi.spyOn(api, 'loginAdmin').mockResolvedValue({
      success: true,
      authenticated: false,
      requiresTotp: true,
      challengeToken: 'totp_challenge_secret',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const verifyTotp = vi.spyOn(api, 'verifyAdminTotp').mockResolvedValue({
      success: true,
      authenticated: true,
      csrfToken: 'mac_totp-csrf',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      secondFactorVerified: true,
      secondFactorType: 'totp',
      recoveryCodesRemaining: 10,
    });
    const root = create(<Login onLogin={onLogin} t={(text) => text} />);

    try {
      const passwordInput = root.root.find((node) => (
        node.type === 'input' && node.props.id === 'admin-token-input'
      ));
      await act(async () => {
        passwordInput.props.onChange({ target: { value: 'administrator-secret' } });
      });
      const loginButton = root.root.findAllByType('button').find((node) => collectText(node) === '登录');
      await act(async () => {
        await loginButton?.props.onClick();
      });

      expect(api.loginAdmin).toHaveBeenCalledWith('administrator-secret');
      expect(onLogin).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain('双重验证');
      expect(root.root.find((node) => node.type === 'input' && node.props.id === 'admin-totp-input')).toBeTruthy();
      expect(root.root.findAll((node) => node.type === 'input' && node.props.id === 'admin-token-input')).toHaveLength(0);

      const totpInput = root.root.find((node) => node.type === 'input' && node.props.id === 'admin-totp-input');
      await act(async () => {
        totpInput.props.onChange({ target: { value: '123456' } });
      });
      const verifyButton = root.root.findAllByType('button').find((node) => collectText(node) === '完成验证');
      await act(async () => {
        await verifyButton?.props.onClick();
      });

      expect(verifyTotp).toHaveBeenCalledWith('totp_challenge_secret', '123456');
      expect(onLogin).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });
});
