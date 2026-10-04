import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helm = process.env.HELM_BIN || 'helm';
const helmAvailable = spawnSync(helm, ['version', '--short'], { encoding: 'utf8' }).status === 0;
const chart = resolve('deploy/k3s/chart');
const managedEnv = { authToken: 'bootstrap-test-token', dbUrl: 'postgres://test:test@db:5432/metapi' };

function template(values: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r-api-helm-'));
  try {
    const valuesFile = join(dir, 'values.json');
    writeFileSync(valuesFile, JSON.stringify(values));
    return spawnSync(helm, ['template', 'test', chart, '--namespace', 'ai', '-f', valuesFile], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function successfulTemplate(values: Record<string, unknown>) {
  const result = template(values);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

// CI installs Helm. Local npm test can run without it; set HELM_BIN to use a
// task-local binary. These checks render real templates without cluster access.
describe.skipIf(!helmAvailable)('Helm environment Secret contract', () => {
  it('preserves chart-managed default names, bootstrap, database and checksum', () => {
    const output = successfulTemplate({ env: managedEnv });
    expect(output).toMatch(/kind: Secret\nmetadata:\n  name: test-metapi-env/);
    expect(output).toContain('AUTH_TOKEN: "bootstrap-test-token"');
    expect(output).toContain('ADMIN_CREDENTIAL_BOOTSTRAP_REQUIRED: "true"');
    expect(output).toContain(`DB_URL: "${managedEnv.dbUrl}"`);
    expect(output).toContain('ADMIN_SESSION_TTL_MS: "43200000"');
    expect(output).toContain('ADMIN_SESSION_TOUCH_INTERVAL_MS: "300000"');
    expect(output).toMatch(/checksum\/env-secret: "[a-f0-9]{64}"/);
    expect(output).toContain('name: "test-metapi-env"');
    expect(output).not.toContain('AUTH_TOKEN_HASH:');
    expect(output).not.toContain('ACCOUNT_CREDENTIAL_SECRET:');
  });

  it('supports hash-only bootstrap with an independent stable encryption key', () => {
    const hash = '$argon2id$v=19$m=65536,t=3,p=4$test$hash';
    const output = successfulTemplate({ env: { authTokenHash: hash, accountCredentialSecret: 'independent-root-test-key', dbType: 'sqlite', adminSessionTtlMs: 900000, adminSessionTouchIntervalMs: '60000' } });
    expect(output).toContain(`AUTH_TOKEN_HASH: "${hash}"`);
    expect(output).toContain('ACCOUNT_CREDENTIAL_SECRET: "independent-root-test-key"');
    expect(output).not.toContain('AUTH_TOKEN:');
    expect(output).toContain('DB_URL: "./data/hub.db"');
    expect(output).toContain('ADMIN_SESSION_TTL_MS: "900000"');
    expect(output).toContain('ADMIN_SESSION_TOUCH_INTERVAL_MS: "60000"');
  });

  it('allows both bootstrap inputs and puts sensitive values only in Secret resources', () => {
    const sensitive = ['bootstrap-test-token', 'hash-test-value', 'root-test-value', 'helper-test-value', managedEnv.dbUrl];
    const output = successfulTemplate({ env: { ...managedEnv, authTokenHash: sensitive[1], accountCredentialSecret: sensitive[2], deployHelperToken: sensitive[3] } });
    const resources = output.split(/^---\s*$/m).filter((resource) => resource.trim());
    for (const value of sensitive) {
      expect(resources.filter((resource) => /^kind: Secret$/m.test(resource)).join('\n')).toContain(value);
      for (const resource of resources.filter((resource) => !/^kind: Secret$/m.test(resource))) expect(resource).not.toContain(value);
    }
  });

  it('uses an external Secret without requiring bootstrap or database values', () => {
    const output = successfulTemplate({ existingSecret: 'shared.runtime-env' });
    expect(output).toContain('name: "shared.runtime-env"');
    expect(output).not.toMatch(/^kind: Secret$/m);
    expect(output).not.toContain('checksum/env-secret');
    expect(output).not.toContain('stringData:');
  });

  it('ignores managed env values in external mode and preserves image digest support', () => {
    const values = { existingSecret: 'external-env', env: { ...managedEnv, accountCredentialSecret: 'must-not-render' }, image: { digest: 'sha256:testdigest' } };
    const output = successfulTemplate(values);
    expect(output).not.toContain('must-not-render');
    expect(output).not.toContain(managedEnv.authToken);
    expect(output).not.toContain(managedEnv.dbUrl);
    expect(output).toContain('image: "1467078763/metapi@sha256:testdigest"');
    expect(output).not.toContain('checksum/env-secret');
  });

  it('updates the managed checksum when Secret data changes', () => {
    const checksum = (output: string) => output.match(/checksum\/env-secret: "([a-f0-9]{64})"/)?.[1];
    expect(checksum(successfulTemplate({ env: managedEnv }))).not.toBe(checksum(successfulTemplate({ env: { ...managedEnv, accountCredentialSecret: 'another-key' } })));
  });

  it.each(['', ' ', 'UPPERCASE', 'bad_name', '-env', 'env.', 'a..b', 'a/b', 'a'.repeat(254), 42, false, ['env'], null])('rejects an invalid external name or missing managed credentials: %j', (existingSecret) => {
    const result = template({ existingSecret, ...(existingSecret === '' ? {} : { env: managedEnv }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/existingSecret|env.authToken or env.authTokenHash/);
  });

  it('treats an explicit empty name as the default managed mode', () => {
    expect(successfulTemplate({ existingSecret: '', env: managedEnv })).toMatch(/^kind: Secret$/m);
  });

  it('preserves a long valid external Secret name without chart-name truncation', () => {
    const existingSecret = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.');
    expect(successfulTemplate({ existingSecret })).toContain(`name: "${existingSecret}"`);
  });

  it('rejects hash-only bootstrap without a credential key', () => {
    const result = template({ env: { authTokenHash: '$argon2id$test', dbType: 'sqlite' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('env.accountCredentialSecret is required');
  });

  it.each(['authToken', 'authTokenHash'])('rejects whitespace-only bootstrap input: %s', (field) => {
    const result = template({ env: { [field]: ' ', dbType: 'sqlite' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('env.authToken or env.authTokenHash is required');
  });

  it('rejects a missing remote database URL in managed mode', () => {
    const result = template({ env: { authToken: managedEnv.authToken } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('env.dbUrl is required');
  });

  it.each(['adminSessionTtlMs', 'adminSessionTouchIntervalMs'])('rejects a malformed session setting: %s', (field) => {
    const result = template({ env: { ...managedEnv, [field]: 'not-milliseconds' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(field);
  });

  it.each(['', 'external-env'])('keeps the hostPath scaling guard in both modes: %s', (existingSecret) => {
    const result = template({ existingSecret, replicaCount: 2, env: managedEnv });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('node-local hostPath storage');
  });
});
