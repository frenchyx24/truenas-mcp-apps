import http from 'node:http';

const TRUENAS_URL = process.env.TRUENAS_URL || 'http://192.168.1.17';
const TRUENAS_TOKEN = process.env.TRUENAS_TOKEN || '';
const PORT = Number(process.env.PORT) || 3004;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

// --- TrueNAS API client ---

async function truenas(method, path, body) {
  const url = `${TRUENAS_URL}/api/v2.0${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${TRUENAS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`TrueNAS ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// --- Tool definitions ---

const TOOLS = [
  // Apps
  {
    name: 'app_list',
    description: 'List all TrueNAS apps with state, version, and whether an update is available.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/app'),
  },
  {
    name: 'app_details',
    description: 'Get full details for a single TrueNAS app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string', description: 'App name as shown in app_list' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('GET', `/app/id/${encodeURIComponent(a.app_name)}`),
  },
  {
    name: 'app_start',
    description: 'Start an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('POST', `/app/id/${encodeURIComponent(a.app_name)}/start`),
  },
  {
    name: 'app_stop',
    description: 'Stop an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('POST', `/app/id/${encodeURIComponent(a.app_name)}/stop`),
  },
  {
    name: 'app_redeploy',
    description: 'Redeploy (restart) an app with its current configuration.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('POST', `/app/id/${encodeURIComponent(a.app_name)}/redeploy`),
  },
  {
    name: 'app_upgrade',
    description: 'Upgrade an app to its latest available version.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('POST', `/app/id/${encodeURIComponent(a.app_name)}/upgrade`),
  },
  {
    name: 'app_delete',
    description: 'Delete an app and its data.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('DELETE', `/app/id/${encodeURIComponent(a.app_name)}`),
  },
  {
    name: 'app_config',
    description: 'Get the current configuration of an app.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string' } },
      required: ['app_name'],
    },
    handler: (a) => truenas('POST', `/app/id/${encodeURIComponent(a.app_name)}/config`),
  },
  {
    name: 'app_update_config',
    description: 'Update an app configuration. Pass the full or partial config object.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string' },
        config: { type: 'object', description: 'Configuration values to change' },
      },
      required: ['app_name', 'config'],
    },
    handler: (a) => truenas('PUT', `/app/id/${encodeURIComponent(a.app_name)}`, { values: a.config }),
  },
  {
    name: 'app_available',
    description: 'List apps available to install from the catalog.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/app/available'),
  },

  // Datasets
  {
    name: 'dataset_list',
    description: 'List all ZFS datasets with used/available space.',
    inputSchema: {
      type: 'object',
      properties: { pool: { type: 'string', description: 'Filter by pool name (optional)' } },
    },
    handler: (a) => {
      const qs = a.pool ? `?pool=${encodeURIComponent(a.pool)}` : '';
      return truenas('GET', `/pool/dataset${qs}`);
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
    handler: (a) => truenas('GET', `/pool/dataset/id/${encodeURIComponent(a.dataset_id)}`),
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
    handler: (a) => truenas('POST', '/pool/dataset', { name: a.name, comments: a.comments || '' }),
  },
  {
    name: 'dataset_delete',
    description: 'Delete a ZFS dataset.',
    inputSchema: {
      type: 'object',
      properties: { dataset_id: { type: 'string' } },
      required: ['dataset_id'],
    },
    handler: (a) => truenas('DELETE', `/pool/dataset/id/${encodeURIComponent(a.dataset_id)}`),
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
      const qs = a.dataset ? `?dataset=${encodeURIComponent(a.dataset)}` : '';
      return truenas('GET', `/zfs/snapshot${qs}`);
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
    handler: (a) => truenas('POST', '/zfs/snapshot', {
      dataset: a.dataset,
      name: a.name,
      recursive: a.recursive || false,
    }),
  },
  {
    name: 'snapshot_delete',
    description: 'Delete a ZFS snapshot.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string', description: 'e.g. "media/tv@snap-2026"' } },
      required: ['snapshot_id'],
    },
    handler: (a) => truenas('DELETE', `/zfs/snapshot/id/${encodeURIComponent(a.snapshot_id)}`),
  },

  // Services
  {
    name: 'service_list',
    description: 'List all TrueNAS services with running state.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/service'),
  },
  {
    name: 'service_start',
    description: 'Start a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'e.g. "cifs", "nfs", "ssh"' } },
      required: ['service'],
    },
    handler: (a) => truenas('POST', '/service/start', { service: a.service }),
  },
  {
    name: 'service_stop',
    description: 'Stop a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
    },
    handler: (a) => truenas('POST', '/service/stop', { service: a.service }),
  },
  {
    name: 'service_restart',
    description: 'Restart a TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' } },
      required: ['service'],
    },
    handler: (a) => truenas('POST', '/service/restart', { service: a.service }),
  },

  // System
  {
    name: 'system_info',
    description: 'Get TrueNAS system information.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/system/info'),
  },
  {
    name: 'system_reboot',
    description: 'Reboot the TrueNAS system. USE WITH CAUTION.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('POST', '/system/reboot'),
  },

  // Shares
  {
    name: 'share_smb_list',
    description: 'List all SMB shares.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/sharing/smb'),
  },
  {
    name: 'share_nfs_list',
    description: 'List all NFS shares.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/sharing/nfs'),
  },

  // Alerts
  {
    name: 'alert_list',
    description: 'List all active alerts.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/alert/list'),
  },

  // Pools
  {
    name: 'pool_list',
    description: 'List all ZFS pools.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/pool'),
  },

  // Disks
  {
    name: 'disk_list',
    description: 'List all disks.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/disk'),
  },

  // Cron
  {
    name: 'cronjob_list',
    description: 'List all cron jobs.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => truenas('GET', '/cronjob'),
  },
  {
    name: 'cronjob_run',
    description: 'Run a cron job now.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Cron job ID' } },
      required: ['id'],
    },
    handler: (a) => truenas('POST', `/cronjob/id/${a.id}/run`),
  },
];

// --- MCP JSON-RPC handler ---

const toolMap = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${AUTH_TOKEN}`;
}

function jsonRPC(result, id) {
  return JSON.stringify({ jsonrpc: '2.0', result, id });
}

function jsonRPCError(code, message, id) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

async function handleRPC(body) {
  const { method, params, id } = body;

  if (method === 'initialize') {
    return jsonRPC({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'truenas-mcp-apps', version: '1.0.0' },
    }, id);
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return jsonRPC({
      tools: TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }, id);
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const tool = toolMap[name];
    if (!tool) return jsonRPCError(-32601, `Unknown tool: ${name}`, id);
    try {
      const result = await tool.handler(args || {});
      return jsonRPC({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }, id);
    } catch (err) {
      return jsonRPC({
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      }, id);
    }
  }

  return jsonRPCError(-32601, `Method not found: ${method}`, id);
}

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', tools: TOOLS.length }));
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
      if (response === null) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response);
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonRPCError(-32700, 'Parse error', null));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`truenas-mcp-apps listening on :${PORT}`);
  console.log(`TrueNAS API: ${TRUENAS_URL}`);
  console.log(`Tools: ${TOOLS.length}`);
  console.log(`Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled'}`);
});
