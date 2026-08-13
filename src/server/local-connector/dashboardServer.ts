import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import getPort from 'get-port';
import type { ConnectorDashboardSnapshot } from './dashboardState.js';

const DEFAULT_PORT = 4765;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function sameToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim();
  try {
    return new URL(request.url || '/', 'http://connector.local').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(DASHBOARD_HTML),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(DASHBOARD_HTML);
}

function localAddresses(host: string, port: number, token: string | null): string[] {
  const suffix = token ? `/?token=${encodeURIComponent(token)}` : '/';
  if (isLoopbackHost(host)) return [`http://127.0.0.1:${port}${suffix}`];
  const addresses = new Set<string>([`http://127.0.0.1:${port}${suffix}`]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(`http://${entry.address}:${port}${suffix}`);
    }
  }
  return [...addresses];
}

export type LocalConnectorDashboardServer = Readonly<{
  host: string;
  port: number;
  token: string | null;
  urls: readonly string[];
  healthUrl: string;
  statusUrl: string;
  close: () => Promise<void>;
}>;

export async function startLocalConnectorDashboardServer(input: {
  host?: string;
  port?: number;
  snapshot: () => Promise<ConnectorDashboardSnapshot>;
}): Promise<LocalConnectorDashboardServer> {
  const host = input.host?.trim() || '127.0.0.1';
  const preferredPort = Math.trunc(input.port || DEFAULT_PORT);
  if (!Number.isFinite(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error('Connector dashboard port must be between 1 and 65535');
  }
  const port = await getPort({
    host,
    port: [preferredPort, preferredPort + 1, preferredPort + 2].filter((value) => value <= 65_535),
  });
  const token = isLoopbackHost(host) ? null : randomBytes(24).toString('base64url');
  const server = createServer(async (request, response) => {
    const method = request.method || 'GET';
    let path = '/';
    try {
      path = new URL(request.url || '/', 'http://connector.local').pathname;
    } catch {
      sendJson(response, 400, { success: false, message: 'Invalid request URL' });
      return;
    }
    if (method !== 'GET') {
      sendJson(response, 405, { success: false, message: 'Method not allowed' });
      return;
    }
    if (token && !sameToken(requestToken(request), token)) {
      sendJson(response, 401, { success: false, message: 'Dashboard token required' });
      return;
    }
    if (path === '/api/status') {
      try {
        sendJson(response, 200, await input.snapshot());
      } catch (error) {
        sendJson(response, 500, {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (path === '/healthz') {
      sendJson(response, 200, { success: true });
      return;
    }
    if (path === '/' || path === '/index.html') {
      sendHtml(response);
      return;
    }
    sendJson(response, 404, { success: false, message: 'Not found' });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const urls = Object.freeze(localAddresses(host, port, token));
  const endpoint = new URL(urls[0]!);
  endpoint.pathname = '/healthz';
  const healthUrl = endpoint.toString();
  endpoint.pathname = '/api/status';
  const statusUrl = endpoint.toString();
  return Object.freeze({
    host,
    port,
    token,
    urls,
    healthUrl,
    statusUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>r-api Connector</title>
  <style>
    :root{color-scheme:light;--bg:#f4f5f7;--panel:#fff;--panel-2:#f8f9fa;--ink:#17191c;--muted:#6a7078;--line:#dfe2e6;--strong:#282c32;--green:#16835d;--green-bg:#e6f5ee;--amber:#a66216;--amber-bg:#fff1dc;--red:#b33b44;--red-bg:#fdebed;--blue:#2369a5;--blue-bg:#e7f1fb;--shadow:0 1px 2px rgba(20,24,28,.05)}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111315;--panel:#1a1d20;--panel-2:#22262a;--ink:#f1f3f4;--muted:#9ca3ab;--line:#30353a;--strong:#fff;--green:#62c49d;--green-bg:#173a2d;--amber:#e2aa62;--amber-bg:#3b2d1c;--red:#ef8990;--red-bg:#412326;--blue:#83b8e6;--blue-bg:#1e3448;--shadow:none}}
    *{box-sizing:border-box}html{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);letter-spacing:0}body{margin:0;min-width:320px}button{font:inherit}code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}.shell{min-height:100vh}.topbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--panel) 92%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(14px)}.topbar-inner{max-width:1440px;margin:0 auto;min-height:64px;padding:0 24px;display:flex;align-items:center;gap:16px}.brand{display:flex;align-items:center;gap:11px;min-width:0}.mark{width:30px;height:30px;border:1px solid var(--line);display:grid;place-items:center;background:var(--strong);color:var(--panel);font-size:12px;font-weight:800}.brand-copy{min-width:0}.brand-name{font-size:14px;font-weight:750;line-height:1.2}.brand-sub{font-size:11px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top-status{margin-left:auto;display:flex;align-items:center;gap:10px}.pulse{width:8px;height:8px;border-radius:50%;background:var(--muted)}.pulse.online{background:var(--green);box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 14%,transparent)}.pulse.degraded{background:var(--amber);box-shadow:0 0 0 4px color-mix(in srgb,var(--amber) 14%,transparent)}.top-status-label{font-size:12px;font-weight:650}.refresh{width:34px;height:34px;border:1px solid var(--line);background:var(--panel);color:var(--ink);display:grid;place-items:center;cursor:pointer}.refresh:hover{background:var(--panel-2)}.refresh svg{width:16px;height:16px}.refresh.busy svg{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}main{max-width:1440px;margin:0 auto;padding:24px}.overview{display:grid;grid-template-columns:minmax(0,1.45fr) repeat(3,minmax(150px,.55fr));border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow)}.overview-main{padding:22px 24px;border-right:1px solid var(--line)}.eyebrow{font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:700}.overview-title{margin-top:8px;font-size:21px;font-weight:750;line-height:1.25}.overview-meta{margin-top:8px;color:var(--muted);font-size:12px;display:flex;gap:14px;flex-wrap:wrap}.metric{padding:20px;display:flex;flex-direction:column;justify-content:space-between;border-right:1px solid var(--line);min-height:112px}.metric:last-child{border-right:0}.metric-label{font-size:11px;color:var(--muted);font-weight:650}.metric-value{font-size:28px;font-weight:760;line-height:1}.metric-note{font-size:11px;color:var(--muted)}.layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(310px,.75fr);gap:16px;margin-top:16px}.stack{display:grid;gap:16px}.panel{border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow);min-width:0}.panel-head{min-height:54px;padding:0 17px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}.panel-title{font-size:13px;font-weight:720}.panel-count{font-size:11px;color:var(--muted);margin-left:2px}.panel-extra{margin-left:auto;color:var(--muted);font-size:11px}.session-list,.interaction-list,.event-list{display:grid}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:15px 17px;border-bottom:1px solid var(--line);min-width:0}.row:last-child{border-bottom:0}.row-main{min-width:0}.row-title{font-size:13px;font-weight:680;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row-sub{font-size:11px;color:var(--muted);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;min-width:0}.row-sub code{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.badge{align-self:start;display:inline-flex;align-items:center;min-height:24px;padding:0 8px;border:1px solid var(--line);font-size:10px;font-weight:750;text-transform:uppercase;white-space:nowrap}.badge.active,.badge.connected,.badge.online{color:var(--green);background:var(--green-bg);border-color:color-mix(in srgb,var(--green) 28%,var(--line))}.badge.external{color:var(--blue);background:var(--blue-bg);border-color:color-mix(in srgb,var(--blue) 28%,var(--line))}.badge.waiting,.badge.connecting,.badge.degraded{color:var(--amber);background:var(--amber-bg);border-color:color-mix(in srgb,var(--amber) 28%,var(--line))}.badge.error,.badge.system_error{color:var(--red);background:var(--red-bg);border-color:color-mix(in srgb,var(--red) 28%,var(--line))}.badge.idle,.badge.disabled,.badge.unknown,.badge.not_loaded{color:var(--muted);background:var(--panel-2)}.empty{padding:34px 18px;text-align:center;color:var(--muted);font-size:12px}.runtime{padding:15px 17px;display:grid;gap:12px}.runtime-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;font-size:11px}.runtime-label{color:var(--muted)}.runtime-value{min-width:0;overflow-wrap:anywhere}.queue-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--line)}.queue-cell{padding:14px 17px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.queue-cell:nth-child(2n){border-right:0}.queue-cell:nth-last-child(-n+2){border-bottom:0}.queue-name{font-size:10px;color:var(--muted)}.queue-value{margin-top:7px;font-size:18px;font-weight:730}.event-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:11px;padding:13px 17px;border-bottom:1px solid var(--line);align-items:start}.event-row:last-child{border-bottom:0}.event-dot{width:7px;height:7px;border-radius:50%;background:var(--blue);margin-top:5px}.event-dot.warning{background:var(--amber)}.event-dot.error{background:var(--red)}.event-title{font-size:12px;font-weight:650}.event-detail{font-size:11px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}.event-time{font-size:10px;color:var(--muted);white-space:nowrap}.error-banner{display:none;margin:0 0 16px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--red) 35%,var(--line));background:var(--red-bg);color:var(--red);font-size:12px}.error-banner.show{display:block}.footer{padding:22px 0 4px;color:var(--muted);font-size:10px;text-align:center}@media(max-width:980px){.overview{grid-template-columns:repeat(3,1fr)}.overview-main{grid-column:1/-1;border-right:0;border-bottom:1px solid var(--line)}.metric{min-height:96px}.layout{grid-template-columns:1fr}.side{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.side .events-panel{grid-column:1/-1}}@media(max-width:640px){.topbar-inner{padding:0 14px;min-height:58px}.brand-sub,.top-status-label{display:none}main{padding:12px}.overview{grid-template-columns:repeat(3,minmax(0,1fr))}.overview-main{padding:18px}.overview-title{font-size:18px}.overview-meta{display:grid;gap:5px}.metric{padding:13px 11px;min-height:88px}.metric-value{font-size:23px}.metric-label{font-size:10px}.metric-note{display:none}.layout,.stack{gap:12px;margin-top:12px}.side{grid-template-columns:1fr}.side .events-panel{grid-column:auto}.panel-head{min-height:50px;padding:0 14px}.row{padding:14px}.row-sub{display:grid;gap:5px}.runtime{padding:14px}.runtime-row{grid-template-columns:86px minmax(0,1fr)}.event-row{padding:12px 14px}.event-time{display:none}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar"><div class="topbar-inner"><div class="brand"><div class="mark">r</div><div class="brand-copy"><div class="brand-name">r-api Connector</div><div class="brand-sub" id="device-label">Local runtime</div></div></div><div class="top-status"><span class="pulse" id="top-pulse"></span><span class="top-status-label" id="top-status">Connecting</span><button class="refresh" id="refresh" type="button" title="刷新" aria-label="刷新"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg></button></div></div></header>
    <main><div class="error-banner" id="error"></div><section class="overview"><div class="overview-main"><div class="eyebrow">Local-first runtime</div><div class="overview-title" id="overview-title">Connector 正在启动</div><div class="overview-meta"><span id="server-url">-</span><span id="uptime">-</span><span id="updated-at">-</span></div></div><div class="metric"><div class="metric-label">运行会话</div><div class="metric-value" id="metric-sessions">0</div><div class="metric-note">Codex active threads</div></div><div class="metric"><div class="metric-label">等待交互</div><div class="metric-value" id="metric-interactions">0</div><div class="metric-note">Approval and input</div></div><div class="metric"><div class="metric-label">本地积压</div><div class="metric-value" id="metric-queue">0</div><div class="metric-note">Durable deliveries</div></div></section>
      <div class="layout"><div class="stack"><section class="panel"><div class="panel-head"><div class="panel-title">会话</div><div class="panel-count" id="session-count"></div><div class="panel-extra">运行中优先</div></div><div class="session-list" id="sessions"></div></section><section class="panel"><div class="panel-head"><div class="panel-title">Codex 交互审批</div><div class="panel-count" id="interaction-count"></div><div class="panel-extra">审批与用户输入</div></div><div class="interaction-list" id="interactions"></div></section></div>
        <div class="stack side"><section class="panel"><div class="panel-head"><div class="panel-title">运行环境</div><span class="badge" id="app-server-badge">disabled</span></div><div class="runtime" id="runtime"></div><div class="queue-grid" id="queue"></div></section><section class="panel events-panel"><div class="panel-head"><div class="panel-title">最近事件</div><div class="panel-count" id="event-count"></div></div><div class="event-list" id="events"></div></section></div></div><div class="footer">数据来自本机 Connector，页面每 2 秒刷新</div></main>
  </div>
  <script>
    const token=new URLSearchParams(location.search).get('token')||'';const apiUrl='/api/status'+(token?'?token='+encodeURIComponent(token):'');const $=id=>document.getElementById(id);const escapeHtml=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));const formatTime=value=>{if(!value)return'-';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():String(value)};const relative=value=>{const time=Date.parse(value||'');if(!Number.isFinite(time))return'-';const seconds=Math.max(0,Math.round((Date.now()-time)/1000));if(seconds<60)return seconds+' 秒前';if(seconds<3600)return Math.floor(seconds/60)+' 分钟前';if(seconds<86400)return Math.floor(seconds/3600)+' 小时前';return Math.floor(seconds/86400)+' 天前'};const badge=(text,kind)=>'<span class="badge '+escapeHtml(kind||text)+'">'+escapeHtml(text)+'</span>';const empty=text=>'<div class="empty">'+escapeHtml(text)+'</div>';
    let busy=false;async function load(){if(busy)return;busy=true;$('refresh').classList.add('busy');try{const response=await fetch(apiUrl,{headers:{accept:'application/json'}});if(!response.ok)throw new Error('HTTP '+response.status);const data=await response.json();render(data);$('error').classList.remove('show')}catch(error){$('error').textContent='无法读取本地 Connector 状态：'+(error&&error.message?error.message:String(error));$('error').classList.add('show')}finally{busy=false;$('refresh').classList.remove('busy')}}
    function render(data){const connector=data.connector||{};const app=data.appServer||{};const summary=data.summary||{};$('device-label').textContent=connector.deviceId||'Local runtime';$('top-pulse').className='pulse '+(connector.status||'');$('top-status').textContent=connector.status||'unknown';$('overview-title').textContent=connector.status==='online'?'Connector 在线':connector.status==='degraded'?'Connector 降级运行':connector.status==='stopping'?'Connector 正在停止':'Connector 正在启动';$('server-url').textContent=connector.serverUrl||'-';$('uptime').textContent='启动于 '+formatTime(connector.startedAt);$('updated-at').textContent='更新 '+relative(data.generatedAt);$('metric-sessions').textContent=summary.activeSessions||0;$('metric-interactions').textContent=summary.waitingInteractions||0;$('metric-queue').textContent=summary.queuedDeliveries||0;$('app-server-badge').textContent=app.status||'disabled';$('app-server-badge').className='badge '+(app.status||'disabled');renderSessions(data.sessions||[],app);renderInteractions(data.interactions||[]);renderRuntime(connector,app);renderQueue(data.queue||{});renderEvents(data.events||[])}
    function renderSessions(items,app){$('session-count').textContent=items.length+' 个';$('sessions').innerHTML=items.length?items.map(item=>{const external=item.controlState==='external_owner';const direct=app.mode==='control';const source=direct?(external?'Codex Desktop · 可追加消息':'Codex 直连 · 可控制'):'Codex 会话 · 仅观察';const badgeText=item.activeFlags&&item.activeFlags.length?item.activeFlags.join(' / '):item.status;const badgeKind=item.activeFlags&&item.activeFlags.length?'waiting':item.status;return '<div class="row"><div class="row-main"><div class="row-title">'+escapeHtml(item.title||item.threadId)+'</div><div class="row-sub"><code>'+escapeHtml(item.threadId)+'</code><span>'+escapeHtml(source)+'</span>'+(item.cwd?'<span>'+escapeHtml(item.cwd)+'</span>':'')+(item.activeTurnId?'<span>turn '+escapeHtml(item.activeTurnId)+'</span>':'')+'<span>'+escapeHtml(relative(item.updatedAt))+'</span></div></div>'+badge(badgeText,badgeKind)+'</div>'}).join(''):empty('还没有观察到会话')}
    function renderInteractions(items){$('interaction-count').textContent=items.length+' total';$('interactions').innerHTML=items.length?items.map(item=>'<div class="row"><div class="row-main"><div class="row-title">'+escapeHtml(item.kind)+' · '+escapeHtml(item.method)+'</div><div class="row-sub"><code>'+escapeHtml(item.interactionId||item.sourceRequestId)+'</code>'+(item.threadId?'<span>thread '+escapeHtml(item.threadId)+'</span>':'')+(item.expiresAt?'<span>到期 '+escapeHtml(formatTime(item.expiresAt))+'</span>':'')+'</div></div>'+badge(item.status,item.status==='waiting'?'waiting':item.status==='resolved'?'idle':'active')+'</div>').join(''):empty('当前没有等待中的审批或输入')}
    function renderRuntime(connector,app){const syncLabel={unknown:'检测中',supported:'已启用',unsupported:'线上接口未部署',error:'同步异常'}[connector.threadSnapshotSyncStatus]||'未知';const rows=[['App Server',app.mode+' / '+app.status],['会话上报',syncLabel],['Endpoint',app.endpoint||'-'],['PID',connector.pid||'-'],['轮询间隔',(connector.pollIntervalMs||0)+' ms'],['r-api 成功',formatTime(connector.lastServerSuccessAt)],['r-api 错误',connector.lastServerError||'-'],['上报时间',formatTime(connector.lastThreadSnapshotSyncAt)],['上报错误',connector.lastThreadSnapshotSyncError||'-'],['当前动作',connector.activeActionId||'-'],['Bridge 任务',connector.activeBridgeTaskId||'-']];$('runtime').innerHTML=rows.map(row=>'<div class="runtime-row"><div class="runtime-label">'+escapeHtml(row[0])+'</div><div class="runtime-value">'+escapeHtml(row[1])+'</div></div>').join('')}
    function renderQueue(queue){const rows=[['普通事件',queue.events||0],['动作结果',queue.results||0],['Bridge 事件',queue.bridgeEvents||0],['Bridge 结果',queue.bridgeResults||0]];$('queue').innerHTML=rows.map(row=>'<div class="queue-cell"><div class="queue-name">'+escapeHtml(row[0])+'</div><div class="queue-value">'+escapeHtml(row[1])+'</div></div>').join('')}
    function renderEvents(items){const shown=items.slice(0,40);$('event-count').textContent=shown.length+' recent';$('events').innerHTML=shown.length?shown.map(item=>'<div class="event-row"><span class="event-dot '+escapeHtml(item.level)+'"></span><div><div class="event-title">'+escapeHtml(item.title)+'</div><div class="event-detail">'+escapeHtml(item.detail)+(item.threadId?' · '+escapeHtml(item.threadId):'')+'</div></div><div class="event-time">'+escapeHtml(relative(item.occurredAt))+'</div></div>').join(''):empty('暂无运行事件')}
    $('refresh').addEventListener('click',load);load();setInterval(load,2000);
  </script>
</body>
</html>`;
