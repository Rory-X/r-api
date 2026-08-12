import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { join, resolve } from 'node:path';
import type { LocalConnectorActionKind, LocalConnectorAgent } from './protocol.js';
import {
  atomicRemoveFile,
  atomicWriteFile,
  ensurePrivateDirectory,
  readOptionalFile,
} from './atomicFile.js';

const BACKUP_PROTOCOL = 'metapi.local-connector.backup.v1' as const;
const BACKUP_REF_PATTERN = /^lcb_[a-f0-9-]{36}$/;

type EncryptedBackupEnvelope = {
  protocol: typeof BACKUP_PROTOCOL;
  ref: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
};

type BackupPayload = {
  targetPath: string;
  agent: LocalConnectorAgent;
  kind: LocalConnectorActionKind;
  existed: boolean;
  content: string;
  mode: number | null;
  sha256: string | null;
};

export type LocalConnectorBackupResult = {
  backupRef: string;
  existed: boolean;
  sha256: string | null;
};

function decodeBackupKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) throw new Error('Connector 本地备份密钥无效');
  return key;
}

function backupPath(dataDir: string, backupRef: string): string {
  if (!BACKUP_REF_PATTERN.test(backupRef)) throw new Error('Connector backupRef 无效');
  return join(resolve(dataDir), 'backups', `${backupRef}.json`);
}

function backupAad(ref: string): Buffer {
  return Buffer.from(`${BACKUP_PROTOCOL}\0${ref}`, 'utf8');
}

export async function createLocalConnectorBackup(input: {
  dataDir: string;
  backupKey: string;
  targetPath: string;
  agent: LocalConnectorAgent;
  kind: LocalConnectorActionKind;
}): Promise<LocalConnectorBackupResult> {
  const snapshot = await readOptionalFile(input.targetPath);
  const backupRef = `lcb_${randomUUID()}`;
  const sha256 = snapshot.exists
    ? createHash('sha256').update(snapshot.data).digest('hex')
    : null;
  const payload: BackupPayload = {
    targetPath: resolve(input.targetPath),
    agent: input.agent,
    kind: input.kind,
    existed: snapshot.exists,
    content: snapshot.exists ? snapshot.data.toString('base64') : '',
    mode: snapshot.mode,
    sha256,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeBackupKey(input.backupKey), iv);
  cipher.setAAD(backupAad(backupRef));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const envelope: EncryptedBackupEnvelope = {
    protocol: BACKUP_PROTOCOL,
    ref: backupRef,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  const directory = join(resolve(input.dataDir), 'backups');
  await ensurePrivateDirectory(directory);
  await atomicWriteFile(backupPath(input.dataDir, backupRef), `${JSON.stringify(envelope)}\n`, 0o600);
  return { backupRef, existed: snapshot.exists, sha256 };
}

function parseEnvelope(raw: Buffer, expectedRef: string): EncryptedBackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Connector 本地备份文件损坏');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector 本地备份文件损坏');
  }
  const envelope = parsed as Partial<EncryptedBackupEnvelope>;
  if (envelope.protocol !== BACKUP_PROTOCOL || envelope.ref !== expectedRef
    || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string' || typeof envelope.createdAt !== 'string') {
    throw new Error('Connector 本地备份协议无效');
  }
  return envelope as EncryptedBackupEnvelope;
}

function decryptPayload(envelope: EncryptedBackupEnvelope, backupKey: string): BackupPayload {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      decodeBackupKey(backupKey),
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(backupAad(envelope.ref));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString('utf8')) as Partial<BackupPayload>;
    if (typeof payload.targetPath !== 'string'
      || (payload.agent !== 'codex' && payload.agent !== 'claude_code')
      || (payload.kind !== 'hook' && payload.kind !== 'notify')
      || typeof payload.existed !== 'boolean'
      || typeof payload.content !== 'string'
      || (payload.mode !== null && typeof payload.mode !== 'number')
      || (payload.sha256 !== null && typeof payload.sha256 !== 'string')) {
      throw new Error('payload invalid');
    }
    return payload as BackupPayload;
  } catch {
    throw new Error('Connector 本地备份无法解密或完整性校验失败');
  }
}

export async function restoreLocalConnectorBackup(input: {
  dataDir: string;
  backupKey: string;
  backupRef: string;
  targetPath: string;
  agent: LocalConnectorAgent;
  kind: LocalConnectorActionKind;
}): Promise<{ restored: boolean; existed: boolean; sha256: string | null }> {
  const snapshot = await readOptionalFile(backupPath(input.dataDir, input.backupRef), 4 * 1024 * 1024);
  if (!snapshot.exists) throw new Error('Connector 本地备份不存在');
  const envelope = parseEnvelope(snapshot.data, input.backupRef);
  const payload = decryptPayload(envelope, input.backupKey);
  if (payload.targetPath !== resolve(input.targetPath)
    || payload.agent !== input.agent
    || payload.kind !== input.kind) {
    throw new Error('Connector 本地备份与当前动作目标不匹配');
  }
  if (!payload.existed) {
    const removed = await atomicRemoveFile(input.targetPath);
    return { restored: removed, existed: false, sha256: null };
  }
  const content = Buffer.from(payload.content, 'base64');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== payload.sha256) throw new Error('Connector 本地备份内容校验失败');
  await atomicWriteFile(input.targetPath, content, payload.mode ?? 0o600);
  return { restored: true, existed: true, sha256 };
}
