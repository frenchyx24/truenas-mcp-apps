import http from 'node:http';
import { WebSocket } from 'ws';

const TRUENAS_HOST_RAW = process.env.TRUENAS_HOST || '192.168.1.17:4545';
const TRUENAS_API_KEY = process.env.TRUENAS_API_KEY || '';
const TRUENAS_USERNAME = process.env.TRUENAS_USERNAME || '';
const TRUENAS_PASSWORD = process.env.TRUENAS_PASSWORD || '';
const TRUENAS_INSECURE = process.env.TRUENAS_INSECURE === 'true';

// Transport selection.
// TRUENAS_HOST may be a bare "host:port" or carry a scheme:
//   https:// or wss://  -> encrypted WebSocket (wss)
//   http://  or ws://   -> plain WebSocket (ws)
// TRUENAS_PROTOCOL (ws | wss | http | https) overrides the scheme. Default: wss.
function resolveTransport(raw, override) {
  const m = /^(https?|wss?):\/\//i.exec(raw);
  const host = (m ? raw.slice(m[0].length) : raw).replace(/\/+$/, '');
  const scheme = (override || (m && m[1]) || 'wss').toLowerCase();
  if (!['ws', 'wss', 'http', 'https'].includes(scheme)) {
    throw new Error(`Invalid TRUENAS_PROTOCOL "${scheme}" (expected ws, wss, http or https)`);
  }
  const secure = scheme === 'wss' || scheme === 'https';
  return { host, secure, url: `${secure ? 'wss' : 'ws'}://${host}/api/current` };
}
const TRANSPORT = resolveTransport(TRUENAS_HOST_RAW, process.env.TRUENAS_PROTOCOL);
const TRUENAS_HOST = TRANSPORT.host;
const TRUENAS_URL = TRANSPORT.url;

if (!TRANSPORT.secure) {
  console.warn('WARNING: plain HTTP/WebSocket transport (ws://). Credentials are sent unencrypted.');
  if (TRUENAS_API_KEY && !(TRUENAS_USERNAME && TRUENAS_PASSWORD)) {
    console.warn('WARNING: TrueNAS 25.04+ automatically revokes API keys used over an insecure connection. ' +
      'Enable HTTPS on TrueNAS, or set TRUENAS_USERNAME/TRUENAS_PASSWORD instead of TRUENAS_API_KEY.');
  }
}
const PORT = Number(process.env.PORT) || 3004;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
function dockerRequest(method,path,body){return new Promise((resolve,reject)=>{const req=http.request({socketPath:DOCKER_SOCKET,path,method,headers:{'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text)}catch{data=text}resolve({status:res.statusCode,data})})});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end()})}
async function dockerExec(container,command){const created=await dockerRequest('POST','/containers/'+encodeURIComponent(container)+'/exec',{AttachStdout:true,AttachStderr:true,Cmd:Array.isArray(command)?command:['sh','-c',command]});if(created.status!==201)throw new Error('Exec create failed: '+JSON.stringify(created.data));const id=created.data.Id;const started=await dockerRequest('POST','/exec/'+id+'/start',{Detach:false,Tty:true});if(started.status!==200)throw new Error('Exec start failed: '+JSON.stringify(started.data));const inspected=await dockerRequest('GET','/exec/'+id+'/json');return{output:typeof started.data==='string'?started.data:JSON.stringify(started.data),exitCode:inspected.data?.ExitCode??null}}


if (TRUENAS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- TrueNAS WebSocket JSON-RPC client ---

let ws = null;
let wsReady = false;
let rpcId = 0;
const pending = new Map();
let authenticated = false;

function connect() {
  const url = TRUENAS_URL;
  console.log(`Connecting to ${url}`);
  ws = new WebSocket(url, TRANSPORT.secure ? { rejectUnauthorized: !TRUENAS_INSECURE } : {});

  ws.on('open', async () => {
    console.log('WebSocket connected, authenticating...');
    try {
      let ok;
      if (TRUENAS_USERNAME && TRUENAS_PASSWORD) {
        ok = await rpcCall('auth.login', [TRUENAS_USERNAME, TRUENAS_PASSWORD]);
      } else {
        ok = await rpcCall('auth.login_with_api_key', [TRUENAS_API_KEY]);
      }
      if (ok === false) throw new Error('invalid credentials');
      authenticated = true;
      wsReady = true;
      console.log('Authenticated successfully');
    } catch (e) {
      console.error('Auth failed:', e.message);
      ws.close();
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {}
  });

  ws.on('close', () => {
    wsReady = false;
    authenticated = false;
    console.log('WebSocket closed, reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (TRANSPORT.secure && /wrong version number|EPROTO/i.test(err.message)) {
      console.error(`Hint: ${TRUENAS_HOST} does not speak TLS. If TrueNAS only serves HTTP on this port, ` +
        'set TRUENAS_PROTOCOL=ws (or TRUENAS_HOST=http://host:port), or point TRUENAS_HOST at its HTTPS port.');
    }
  });
}

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket not connected'));
    }
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }
    }, 120000);
  });
}

async function ensureConnected() {
  if (wsReady && authenticated) return;
  await new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (wsReady && authenticated) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); reject(new Error('Connection timeout')); }, 15000);
  });
}

// For job methods: call and wait for the job to complete
async function rpcJob(method, params = []) {
  const jobId = await rpcCall(method, params);
  // Poll job status
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await rpcCall('core.get_jobs', [[['id', '=', jobId]]]);
    if (job && job.length > 0) {
      const j = job[0];
      if (j.state === 'SUCCESS') return j.result;
      if (j.state === 'FAILED') throw new Error(j.error || 'Job failed');
      if (j.state === 'ABORTED') throw new Error('Job aborted');
    }
  }
  throw new Error('Job timeout');
}

// --- Tool definitions ---

const TOOLS = [
  // Apps
  {
    name: 'app_list',
    description: 'List all TrueNAS apps with state, version, and whether an update is available.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('app.query'),
  },
  {
    name: 'app_details',
    description: 'Get full details for a single TrueNAS app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string', description: 'App name as shown in app_list' } },
      required: ['app_name'],
    },
    handler: (a) => rpcCall('app.get_instance', [a.app_name]),
  },
  {
    name: 'app_start',
    description: 'Start an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcJob('app.start', [a.app_name]),
  },
  {
    name: 'app_stop',
    description: 'Stop an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcJob('app.stop', [a.app_name]),
  },
  {
    name: 'app_redeploy',
    description: 'Redeploy (restart) an app with its current configuration.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcJob('app.redeploy', [a.app_name]),
  },
  {
    name: 'app_upgrade',
    description: 'Upgrade an app to its latest available version.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string' },
        app_version: { type: 'string', description: 'Target version, default "latest"' },
      },
      required: ['app_name'],
    },
    handler: (a) => rpcJob('app.upgrade', [a.app_name, { app_version: a.app_version || 'latest' }]),
  },
  {
    name: 'app_delete',
    description: 'Delete an app and its data.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcJob('app.delete', [a.app_name]),
  },
  {
    name: 'app_config',
    description: 'Get the current configuration of an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcCall('app.config', [a.app_name]),
  },
  {
    name: 'app_update_config',
    description: 'Update an app configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string' },
        config: { type: 'object', description: 'Configuration values to change' },
      },
      required: ['app_name', 'config'],
    },
    handler: (a) => rpcJob('app.update', [a.app_name, { values: a.config }]),
  },
  {
    name: 'app_available',
    description: 'List apps available to install from the catalog.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('app.available'),
  },
  {
    name: 'app_upgrade_summary',
    description: 'Get upgrade summary for an app (available versions, changelog).',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => rpcCall('app.upgrade_summary', [a.app_name]),
  },
  {
    name: 'app_rollback',
    description: 'Rollback an app to a previous version.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string' },
        app_version: { type: 'string', description: 'Version to rollback to' },
      },
      required: ['app_name', 'app_version'],
    },
    handler: (a) => rpcJob('app.rollback', [a.app_name, { app_version: a.app_version }]),
  },

  { name:'container_list',description:'List all Docker containers.',inputSchema:{type:'object',properties:{}},handler:async()=>{const r=await dockerRequest('GET','/containers/json?all=true');if(r.status!==200)throw new Error(JSON.stringify(r.data));return r.data.map(c=>({id:c.Id.slice(0,12),name:(c.Names[0]||'').replace(/^\//,''),image:c.Image,state:c.State,status:c.Status}))} },
  { name:'container_exec',description:'Execute a shell command inside a running container.',inputSchema:{type:'object',properties:{container:{type:'string'},command:{type:'string'}},required:['container','command']},handler:a=>dockerExec(a.container,a.command) },
  { name:'container_file_read',description:'Read a file inside a running container.',inputSchema:{type:'object',properties:{container:{type:'string'},path:{type:'string'}},required:['container','path']},handler:a=>dockerExec(a.container,['cat',a.path]) },
  { name:'container_file_write',description:'Write text to a file inside a running container.',inputSchema:{type:'object',properties:{container:{type:'string'},path:{type:'string'},content:{type:'string'}},required:['container','path','content']},handler:a=>dockerExec(a.container,['sh','-c','printf %s '+JSON.stringify(a.content)+' > '+JSON.stringify(a.path)]) },
  { name:'container_file_list',description:'List files in a directory inside a running container.',inputSchema:{type:'object',properties:{container:{type:'string'},path:{type:'string'}},required:['container','path']},handler:a=>dockerExec(a.container,['ls','-la',a.path]) },
  // Datasets
  {
    name: 'dataset_list',
    description: 'List all ZFS datasets with used/available space.',
    inputSchema: {
      type: 'object',
      properties: { pool: { type: 'string', description: 'Filter by pool name (optional)' } },
    },
    handler: (a) => {
      const filters = a.pool ? [['pool', '=', a.pool]] : [];
      return rpcCall('pool.dataset.query', [filters]);
    },
  },
  {
    name: 'dataset_details',
    description: 'Get full details for a single dataset.',
    inputSchema: {
      type: 'object',
      properties: { dataset_id: { type: 'string', description: 'e.g. "media/tv"' } },
      required: ['dataset_id'],
    },
    handler: (a) => rpcCall('pool.dataset.get_instance', [a.dataset_id]),
  },
  {
    name: 'dataset_create',
    description: 'Create a new ZFS dataset.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full dataset name e.g. "media/backup"' },
        comments: { type: 'string' },
      },
      required: ['name'],
    },
    handler: (a) => rpcCall('pool.dataset.create', [{ name: a.name, comments: a.comments || '' }]),
  },
  {
    name: 'dataset_delete',
    description: 'Delete a ZFS dataset.',
    inputSchema: {
      type: 'object',
      properties: { dataset_id: { type: 'string' } },
      required: ['dataset_id'],
    },
    handler: (a) => rpcCall('pool.dataset.delete', [a.dataset_id]),
  },

  // Snapshots
  {
    name: 'snapshot_list',
    description: 'List ZFS snapshots, optionally filtered by dataset.',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string' } },
    },
    handler: (a) => {
      const filters = a.dataset ? [['dataset', '=', a.dataset]] : [];
      return rpcCall('zfs.snapshot.query', [filters]);
    },
  },
  {
    name: 'snapshot_create',
    description: 'Create a ZFS snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string' },
        name: { type: 'string', description: 'Snapshot suffix name' },
        recursive: { type: 'boolean' },
      },
      required: ['dataset', 'name'],
    },
    handler: (a) => rpcCall('zfs.snapshot.create', [{ dataset: a.dataset, name: a.name, recursive: a.recursive || false }]),
  },
  {
    name: 'snapshot_delete',
    description: 'Delete a ZFS snapshot.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string', description: 'e.g. "media/tv@snap-2026"' } },
      required: ['snapshot_id'],
    },
    handler: (a) => rpcCall('zfs.snapshot.delete', [a.snapshot_id]),
  },

  // Services
  {
    name: 'service_list',
    description: 'List all TrueNAS services with running state.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('service.query'),
  },
  {
    name: 'service_start',
    description: 'Start a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'e.g. "cifs", "nfs", "ssh"' } },
      required: ['service'],
    },
    handler: (a) => rpcCall('service.start', [a.service]),
  },
  {
    name: 'service_stop',
    description: 'Stop a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
    },
    handler: (a) => rpcCall('service.stop', [a.service]),
  },
  {
    name: 'service_restart',
    description: 'Restart a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
    },
    handler: (a) => rpcCall('service.restart', [a.service]),
  },

  // System
  {
    name: 'system_info',
    description: 'Get TrueNAS system information.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('system.info'),
  },
  {
    name: 'system_reboot',
    description: 'Reboot the TrueNAS system. USE WITH CAUTION.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('system.reboot'),
  },

  // Shares
  {
    name: 'share_smb_list',
    description: 'List all SMB shares.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('sharing.smb.query'),
  },
  {
    name: 'share_nfs_list',
    description: 'List all NFS shares.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('sharing.nfs.query'),
  },

  // Alerts
  {
    name: 'alert_list',
    description: 'List all active alerts.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('alert.list'),
  },

  // Pools
  {
    name: 'pool_list',
    description: 'List all ZFS pools.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('pool.query'),
  },

  // Disks
  {
    name: 'disk_list',
    description: 'List all disks.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('disk.query'),
  },

  // Cron
  {
    name: 'cronjob_list',
    description: 'List all cron jobs.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => rpcCall('cronjob.query'),
  },
  {
    name: 'cronjob_run',
    description: 'Run a cron job now.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Cron job ID' } },
      required: ['id'],
    },
    handler: (a) => rpcCall('cronjob.run', [a.id]),
  },
];

// --- MCP JSON-RPC handler ---

const toolMap = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${AUTH_TOKEN}`;
}

function mcpResult(result, id) {
  return JSON.stringify({ jsonrpc: '2.0', result, id });
}

function mcpError(code, message, id) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

async function handleRPC(body) {
  const { method, params, id } = body;

  if (method === 'initialize') {
    return mcpResult({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'truenas-mcp-apps', version: '3.0.0' },
    }, id);
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return mcpResult({
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }, id);
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const tool = toolMap[name];
    if (!tool) return mcpError(-32601, `Unknown tool: ${name}`, id);
    try {
      await ensureConnected();
      const result = await tool.handler(args || {});
      return mcpResult({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }, id);
    } catch (err) {
      return mcpResult({
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      }, id);
    }
  }

  return mcpError(-32601, `Method not found: ${method}`, id);
}

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: wsReady ? 'ok' : 'connecting', authenticated, tools: TOOLS.length }));
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const response = await handleRPC(parsed);
      if (response === null) { res.writeHead(204); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(response); }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(mcpError(-32700, 'Parse error', null));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`truenas-mcp-apps v2 listening on :${PORT}`);
  console.log(`TrueNAS: ${TRUENAS_URL}`);
  console.log(`TrueNAS auth: ${TRUENAS_USERNAME && TRUENAS_PASSWORD ? 'username/password' : 'API key'}`);
  console.log(`Tools: ${TOOLS.length}`);
  console.log(`Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled'}`);
});

// Start WebSocket connection
connect();
