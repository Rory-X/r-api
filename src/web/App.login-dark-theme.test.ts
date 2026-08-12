import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loginCss(): string {
  return readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8').replace(/\r\n/g, '\n');
}

describe('Login dark theme', () => {
  it('gives the brand panel, form controls, and disabled action explicit dark surfaces', () => {
    const css = loginCss();

    expect(css).toContain('[data-theme="dark"] .login-brand-panel-light {');
    expect(css).toContain('[data-theme="dark"] .login-auth-input {');
    expect(css).toContain('[data-theme="dark"] .login-auth-input::placeholder {');
    expect(css).toContain('[data-theme="dark"] .login-auth-submit:disabled {');
    expect(css).toContain('[data-theme="dark"] .login-brand-panel::before,');
    expect(css).toContain('background: #181b20;');
    expect(css).toContain('background: #111318;');
  });

  it('keeps the login action in the first mobile viewport by compacting brand details', () => {
    const css = loginCss();

    expect(css).toContain('@media (max-width: 640px) {');
    expect(css).toContain(`.login-brand-copy-block,
  .login-compat-line,
  .login-capability-list,
  .login-brand-footer {
    display: none;
  }`);
    expect(css).toContain(`.brand-mark-frame-hero {
    width: 68px;
    height: 68px;`);
  });
});
