import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  buildCodexNotifyArgv,
  isManagedNotifyArgv,
  parseArgvJson,
  type LocalConnectorLaunchCommand,
} from './actionDriver.js';
import { readOptionalFile } from './atomicFile.js';
import type {
  LocalConnectorHealthReason,
  LocalConnectorHealthReportWire,
} from './protocol.js';

type JsonRecord = Record<string, unknown>;

function unavailable(
  reason: LocalConnectorHealthReason,
  observedAt: string,
): LocalConnectorHealthReportWire {
  return { checkId: 'codex_notify', status: 'unavailable', reason, observedAt };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  return value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4_096)
    ? value as string[]
    : null;
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((item, index) => item === expected[index]);
}

async function runtimeAvailable(launch: LocalConnectorLaunchCommand): Promise<boolean> {
  try {
    await access(launch.executable, constants.R_OK | constants.X_OK);
    const cliEntryPath = launch.argv[0];
    if (cliEntryPath && isAbsolute(cliEntryPath)) await access(cliEntryPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectCodexNotifyHealth(input: Readonly<{
  targetPath: string;
  launch: LocalConnectorLaunchCommand;
  configPath: string;
  now?: () => Date;
}>): Promise<LocalConnectorHealthReportWire> {
  const observedAt = (input.now || (() => new Date()))().toISOString();
  const snapshot = await readOptionalFile(input.targetPath, 512 * 1024);
  if (!snapshot.exists) return unavailable('config_missing', observedAt);

  let document: JsonRecord;
  try {
    const parsed = parseToml(snapshot.data.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return unavailable('config_invalid', observedAt);
    }
    document = parsed as JsonRecord;
  } catch {
    return unavailable('config_invalid', observedAt);
  }

  const actual = stringArray(document.notify);
  if (!actual || !isManagedNotifyArgv(actual)) {
    return unavailable('managed_wrapper_missing', observedAt);
  }

  const expected = [input.launch.executable, ...buildCodexNotifyArgv(input.launch, input.configPath)];
  const forwardIndex = actual.indexOf('--forward-notify');
  const command = forwardIndex >= 0 ? actual.slice(0, forwardIndex) : actual;
  if (!sameStringArray(command, expected)) {
    return unavailable('managed_command_mismatch', observedAt);
  }
  if (forwardIndex >= 0) {
    if (forwardIndex !== expected.length
      || actual.length !== expected.length + 2
      || !parseArgvJson(actual[forwardIndex + 1])) {
      return unavailable('forward_notify_invalid', observedAt);
    }
  }
  if (!await runtimeAvailable(input.launch)) return unavailable('runtime_missing', observedAt);
  return { checkId: 'codex_notify', status: 'healthy', reason: null, observedAt };
}
