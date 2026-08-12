import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  buildOwnedAppServerSpawnSpec,
  createSocketAppServerTransport,
  normalizeAppServerNotification,
} from './appServerObserver.js';

const unixSocketTempRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();

describe('local connector app server observer', () => {
  it('normalizes lifecycle metadata without forwarding diff or delta content', () => {
    const event = normalizeAppServerNotification({
      method: 'turn/diff/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', diff: 'SECRET PATCH' },
    });
    expect(event?.message).toBe('thread=thread-1 turn=turn-1');
    expect(event?.message).not.toContain('SECRET PATCH');
    expect(normalizeAppServerNotification({
      method: 'item/agentMessage/delta',
      params: { delta: 'secret output' },
    })).toBeNull();
  });

  it('uses a fixed app-server argv and explicitly disables shell execution', () => {
    const spec = buildOwnedAppServerSpawnSpec('/usr/local/bin/codex', '/workspace', { PATH: '/bin' });
    expect(spec.executable).toBe('/usr/local/bin/codex');
    expect(spec.argv).toEqual(['app-server']);
    expect(spec.options).toMatchObject({ cwd: '/workspace', shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('speaks WebSocket JSON messages over the Codex unix control socket', async () => {
    const directory = await mkdtemp(join(unixSocketTempRoot, 'metapi-ctl-'));
    const socketPath = join(directory, 'app-server-control.sock');
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    let extensionHeader: string | string[] | undefined;
    server.on('upgrade', (request, socket, head) => {
      extensionHeader = request.headers['sec-websocket-extensions'];
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    let transport: Awaited<ReturnType<typeof createSocketAppServerTransport>> | null = null;
    try {
      const connection = once(webSocketServer, 'connection');
      transport = await createSocketAppServerTransport(`unix:${socketPath}`);
      const [webSocket] = await connection;
      expect(extensionHeader).toBeUndefined();

      const outbound = once(webSocket, 'message');
      transport.writable.write('{"id":1,"method":"initialize"}\n');
      const [outboundData] = await outbound;
      expect(outboundData.toString()).toBe('{"id":1,"method":"initialize"}');

      const inbound = once(transport.readable, 'data');
      webSocket.send('{"id":1,"result":{}}');
      const [inboundData] = await inbound;
      expect(inboundData.toString()).toBe('{"id":1,"result":{}}\n');
    } finally {
      await transport?.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('contains writable errors when the control socket closes during a request', async () => {
    const directory = await mkdtemp(join(unixSocketTempRoot, 'metapi-ctl-close-'));
    const socketPath = join(directory, 'app-server-control.sock');
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    let transport: Awaited<ReturnType<typeof createSocketAppServerTransport>> | null = null;
    try {
      const connection = once(webSocketServer, 'connection');
      transport = await createSocketAppServerTransport(`unix:${socketPath}`);
      const [webSocket] = await connection;
      const readableClosed = once(transport.readable, 'close');
      transport.readable.resume();
      webSocket.close();
      await readableClosed;

      transport.writable.write('{"id":2,"method":"thread/list"}\n');
      await new Promise((resolve) => setImmediate(resolve));
      expect(transport.writable.destroyed).toBe(true);
    } finally {
      await transport?.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
