const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

const webPort = Number(process.env.PORT || 8080);
const root = __dirname;
function resolveDataDir() {
  const preferred = process.env.VPS_OPS_DATA_DIR || path.join(root, 'data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'vps-ops-console-data');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const dataDir = resolveDataDir();
const logsDir = path.join(dataDir, 'logs');
const runtimePath = path.join(dataDir, 'runtime.json');
const vpsPath = path.join(dataDir, 'vps.json');
const commandsPath = path.join(dataDir, 'commands.json');
const tunnelsPath = path.join(dataDir, 'tunnels.json');

for (const dir of [dataDir, logsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const clients = new Set();

const defaults = {
  vps: [
    { id: 'v1', name: 'vps-prod-1', host: '1.2.3.4', user: 'root', port: 22, authType: 'key', sshKey: '', online: false },
    { id: 'v2', name: 'vps-prod-2', host: '5.6.7.8', user: 'root', port: 22, authType: 'key', sshKey: '', online: false },
    { id: 'v3', name: 'vps-dev-1', host: '10.0.0.20', user: 'ubuntu', port: 22, authType: 'key', sshKey: '', online: false }
  ],
  commands: [
    { id: 'c1', name: 'Restart App', command: 'pm2 restart app', targets: ['v1'] },
    { id: 'c2', name: 'Deploy Backend', command: 'git pull && npm install && pm2 restart app', targets: ['v1', 'v2'] },
    { id: 'c3', name: 'Check Logs', command: 'pm2 logs app --lines 100', targets: ['v1'] }
  ],
  tunnels: [
    { id: 't1', name: 'localhost:3000 → prod', type: 'L', localPort: 3000, remoteHost: 'localhost', remotePort: 3000, target: 'v1' },
    { id: 't2', name: 'db tunnel', type: 'L', localPort: 3306, remoteHost: 'localhost', remotePort: 3306, target: 'v1' }
  ],
  runtime: {
    processes: {},
    tunnels: {},
    commandRuns: {},
    commandStatus: {},
    tunnelStatus: {},
    history: []
  }
};

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
}

ensureFile(vpsPath, defaults.vps);
ensureFile(commandsPath, defaults.commands);
ensureFile(tunnelsPath, defaults.tunnels);
ensureFile(runtimePath, defaults.runtime);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getRuntime() {
  return { ...defaults.runtime, ...readJson(runtimePath, defaults.runtime) };
}

function setRuntime(value) {
  writeJson(runtimePath, value);
}

function getVps() {
  return readJson(vpsPath, defaults.vps);
}

function setVps(value) {
  writeJson(vpsPath, value);
}

function getCommands() {
  return readJson(commandsPath, defaults.commands);
}

function setCommands(value) {
  writeJson(commandsPath, value);
}

function getTunnels() {
  return readJson(tunnelsPath, defaults.tunnels);
}

function setTunnels(value) {
  writeJson(tunnelsPath, value);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getLogPath(id) {
  return path.join(logsDir, `${id}.log`);
}

function tailLog(id) {
  const filePath = getLogPath(id);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').slice(-12000);
}

function streamEvent(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(line);
}

function appendLog(tab, text) {
  fs.appendFileSync(getLogPath(tab), text);
  streamEvent({ type: 'terminal', tab, data: text });
}

function pushHistory(entry) {
  const runtime = getRuntime();
  const history = Array.isArray(runtime.history) ? runtime.history : [];
  history.unshift({ at: new Date().toISOString(), ...entry });
  runtime.history = history.slice(0, 80);
  setRuntime(runtime);
  streamEvent({ type: 'history', item: runtime.history[0] });
}

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = new net.Socket();
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function enrichVps(item) {
  const open = await checkPort(item.port, item.host === 'localhost' ? '127.0.0.1' : item.host).catch(() => false);
  return { ...item, online: open };
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function safeDelete(obj, key) {
  if (obj && key in obj) delete obj[key];
}

function buildSshArgs(vps, remoteCommand) {
  const args = ['-p', String(vps.port || 22)];
  if (vps.sshKey) args.push('-i', vps.sshKey);
  args.push(`${vps.user}@${vps.host}`);
  if (remoteCommand) args.push(remoteCommand);
  return args;
}

function normalizeVpsAuth(input) {
  const authType = input.authType === 'password' ? 'password' : 'key';
  return {
    ...input,
    authType,
    sshKey: input.sshKey || '',
    password: authType === 'password' ? (input.password || '') : ''
  };
}

function buildSsh2Config(vps) {
  const config = {
    host: vps.host,
    port: Number(vps.port || 22),
    username: vps.user,
    readyTimeout: 8000
  };
  if (vps.authType === 'password') {
    config.password = vps.password || '';
  } else if (vps.sshKey) {
    config.privateKey = fs.readFileSync(vps.sshKey, 'utf8');
  }
  return config;
}

function runRemoteCommandSsh2(vps, command, tab, label, commandId) {
  return new Promise((resolve) => {
    const conn = new Client();
    let output = '';
    let failed = false;
    conn.on('ready', () => {
      appendLog(tab, `[ssh2] connected ${vps.user}@${vps.host}\n`);
      conn.exec(command, (err, stream) => {
        if (err) {
          failed = true;
          appendLog(tab, `[ssh2 exec error] ${err.message}\n`);
          pushHistory({ kind: 'command', name: label, refId: commandId, tab, status: 'failed', error: err.message });
          streamEvent({ type: 'status', entityType: 'command', id: commandId, status: 'failed' });
          conn.end();
          resolve({ ok: false, code: 'EXEC_ERROR', error: err.message });
          return;
        }
        stream.on('data', (chunk) => {
          const text = String(chunk);
          output += text;
          appendLog(tab, text);
        });
        stream.stderr.on('data', (chunk) => {
          const text = String(chunk);
          output += text;
          appendLog(tab, text);
        });
        stream.on('close', (code) => {
          conn.end();
          const success = code === 0;
          pushHistory({ kind: 'command', name: label, refId: commandId, tab, status: success ? 'done' : 'failed', exitCode: code });
          streamEvent({ type: 'status', entityType: 'command', id: commandId, status: success ? 'done' : 'failed', exitCode: code });
          resolve({ ok: success, code, output });
        });
      });
    }).on('error', (error) => {
      failed = true;
      appendLog(tab, `[ssh2 connect error] ${error.message}\n`);
      pushHistory({ kind: 'command', name: label, refId: commandId, tab, status: 'failed', error: error.message });
      streamEvent({ type: 'status', entityType: 'command', id: commandId, status: 'failed' });
      resolve({ ok: false, code: 'CONNECT_ERROR', error: error.message });
    }).on('end', () => {
      if (!failed) appendLog(tab, `[ssh2] disconnected\n`);
    });

    try {
      conn.connect(buildSsh2Config(vps));
    } catch (error) {
      appendLog(tab, `[ssh2 config error] ${error.message}\n`);
      resolve({ ok: false, code: 'CONFIG_ERROR', error: error.message });
    }
  });
}

function execRemoteCommandSsh2(vps, command) {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          resolve({ ok: false, code: 'EXEC_ERROR', error: err.message, stdout, stderr });
          return;
        }
        stream.on('data', (chunk) => { stdout += String(chunk); });
        stream.stderr.on('data', (chunk) => { stderr += String(chunk); });
        stream.on('close', (code) => {
          conn.end();
          resolve({ ok: code === 0, code, stdout, stderr });
        });
      });
    }).on('error', (error) => {
      resolve({ ok: false, code: 'CONNECT_ERROR', error: error.message, stdout, stderr });
    });

    try {
      conn.connect(buildSsh2Config(vps));
    } catch (error) {
      resolve({ ok: false, code: 'CONFIG_ERROR', error: error.message, stdout, stderr });
    }
  });
}

function execRemoteCommandCli(vps, command) {
  return new Promise(async (resolve) => {
    const hasSsh = await sshBinaryExists();
    if (!hasSsh) {
      resolve({ ok: false, code: 'ENOENT', error: 'ssh not found in PATH', stdout: '', stderr: '' });
      return;
    }
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', ...buildSshArgs(vps, command)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => resolve({ ok: false, code: 'SPAWN_ERROR', error: error.message, stdout, stderr }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function execRemoteCommandAny(vps, command) {
  const ssh2Result = await execRemoteCommandSsh2(vps, command);
  if (ssh2Result.ok) return ssh2Result;
  if (vps.authType === 'password') return ssh2Result;
  const cliResult = await execRemoteCommandCli(vps, command);
  if (!cliResult.ok && /bad permissions|UNPROTECTED PRIVATE KEY FILE/i.test(String(cliResult.stderr || cliResult.error || ''))) {
    return { ...cliResult, error: `${cliResult.error || cliResult.stderr || 'SSH failed'}. Hãy bấm "Fix Key Perm" trong form VPS rồi test lại.` };
  }
  return cliResult;
}

function parseHealthOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const values = Object.fromEntries(lines.map((line) => {
    const idx = line.indexOf('=');
    return idx >= 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ''];
  }));
  return {
    uptime: values.UPTIME || '',
    load: values.LOAD || '',
    cpu: values.CPU || '',
    memory: values.MEMORY || '',
    disk: values.DISK || '',
    kernel: values.KERNEL || ''
  };
}

async function getVpsHealth(vpsId) {
  const vps = getVps().find((item) => item.id === vpsId);
  if (!vps) throw new Error('Không tìm thấy VPS');
  const command = "printf 'UPTIME='; uptime -p 2>/dev/null || uptime; printf '\nLOAD='; cat /proc/loadavg 2>/dev/null | awk '{print $1\" \"$2\" \"$3}' || echo n/a; printf '\nCPU='; top -bn1 2>/dev/null | grep 'Cpu(s)' | head -n1 | sed 's/.*, *\([0-9.]*\)%* id.*/\1% idle/' || echo n/a; printf '\nMEMORY='; free -m 2>/dev/null | awk '/Mem:/ {print $3\"MB / \"$2\"MB\"}' || echo n/a; printf '\nDISK='; df -h / 2>/dev/null | awk 'NR==2 {print $3\" / \"$2\" (\"$5\")\"}' || echo n/a; printf '\nKERNEL='; uname -sr 2>/dev/null || echo n/a;";
  const result = await execRemoteCommandAny(vps, command);
  if (!result.ok) {
    return { ok: false, error: result.error || result.stderr || `exit ${result.code}`, metrics: null };
  }
  return { ok: true, metrics: parseHealthOutput(result.stdout), raw: result.stdout };
}

function killPid(pid) {
  if (!pid) return;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

function spawnTracked(command, args, options, meta) {
  let child;
  try {
    child = spawn(command, args, options);
  } catch (error) {
    appendLog(meta.tab, `\n[spawn error] ${error.message}\n`);
    pushHistory({ kind: meta.type, name: meta.label, refId: meta.refId, tab: meta.tab, status: 'failed', error: error.message });
    streamEvent({ type: 'status', entityType: meta.type, id: meta.refId, running: false, status: 'failed', tab: meta.tab });
    streamEvent({ type: 'toast', level: 'error', message: `${meta.label} lỗi: ${error.message}` });
    return null;
  }

  const runtime = getRuntime();

  runtime.processes[meta.runId] = {
    pid: child.pid,
    type: meta.type,
    startedAt: new Date().toISOString(),
    tab: meta.tab,
    refId: meta.refId,
    runId: meta.runId,
    label: meta.label
  };

  if (meta.type === 'command') {
    const arr = runtime.commandRuns[meta.refId] || [];
    arr.push(meta.runId);
    runtime.commandRuns[meta.refId] = arr;
    runtime.commandStatus[meta.refId] = 'running';
    pushHistory({ kind: 'command', name: meta.label, refId: meta.refId, tab: meta.tab, status: 'running' });
  }

  if (meta.type === 'tunnel') {
    runtime.tunnels[meta.refId] = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      tab: meta.tab,
      runId: meta.runId
    };
    runtime.tunnelStatus[meta.refId] = 'running';
    pushHistory({ kind: 'tunnel', name: meta.label, refId: meta.refId, tab: meta.tab, status: 'running' });
  }

  setRuntime(runtime);

  child.on('error', (error) => {
    appendLog(meta.tab, `\n[spawn error] ${error.message}\n`);
    const next = getRuntime();
    safeDelete(next.processes, meta.runId);
    if (meta.type === 'command') {
      next.commandRuns[meta.refId] = (next.commandRuns[meta.refId] || []).filter((id) => id !== meta.runId);
      next.commandStatus[meta.refId] = 'failed';
    }
    if (meta.type === 'tunnel') {
      safeDelete(next.tunnels, meta.refId);
      next.tunnelStatus[meta.refId] = 'failed';
    }
    setRuntime(next);
    pushHistory({ kind: meta.type, name: meta.label, refId: meta.refId, tab: meta.tab, status: 'failed', error: error.message });
    streamEvent({ type: 'status', entityType: meta.type, id: meta.refId, running: false, status: 'failed', tab: meta.tab });
    streamEvent({ type: 'toast', level: 'error', message: `${meta.label} lỗi: ${error.message}` });
  });

  child.stdout?.on('data', (chunk) => appendLog(meta.tab, String(chunk)));
  child.stderr?.on('data', (chunk) => appendLog(meta.tab, String(chunk)));

  child.on('exit', (code) => {
    appendLog(meta.tab, `\n[process exited ${code}]\n`);
    const next = getRuntime();
    safeDelete(next.processes, meta.runId);
    let finalStatus = 'done';

    if (meta.type === 'command') {
      next.commandRuns[meta.refId] = (next.commandRuns[meta.refId] || []).filter((id) => id !== meta.runId);
      finalStatus = code === 0
        ? ((next.commandRuns[meta.refId] || []).length ? 'running' : 'done')
        : ((next.commandRuns[meta.refId] || []).length ? 'running' : 'failed');
      next.commandStatus[meta.refId] = finalStatus;
    }

    if (meta.type === 'tunnel') {
      safeDelete(next.tunnels, meta.refId);
      finalStatus = code === 0 ? 'stopped' : 'failed';
      next.tunnelStatus[meta.refId] = finalStatus;
    }

    setRuntime(next);
    pushHistory({ kind: meta.type, name: meta.label, refId: meta.refId, tab: meta.tab, status: finalStatus, exitCode: code });
    streamEvent({ type: 'status', entityType: meta.type, id: meta.refId, running: false, pid: child.pid, exitCode: code, runId: meta.runId, status: finalStatus, tab: meta.tab });
    streamEvent({ type: 'toast', level: code === 0 ? 'success' : 'error', message: `${meta.label} ${code === 0 ? 'xong' : 'lỗi'} (${code})` });
  });

  streamEvent({ type: 'status', entityType: meta.type, id: meta.refId, running: true, pid: child.pid, runId: meta.runId, status: 'running', tab: meta.tab });
  streamEvent({ type: 'toast', level: 'info', message: `Đang chạy ${meta.label}` });
  return child;
}

async function runCommandReal(commandId) {
  const cmd = getCommands().find((x) => x.id === commandId);
  if (!cmd) throw new Error('Không tìm thấy command');
  const vpsList = getVps();

  for (const targetId of cmd.targets) {
    const vps = vpsList.find((x) => x.id === targetId);
    if (!vps) continue;
    const runId = `run-${commandId}-${targetId}-${Date.now()}`;
    const tab = `cmd-${commandId}-${targetId}`;
    appendLog(tab, `$ ssh ${vps.user}@${vps.host} -p ${vps.port} "${cmd.command}"\n`);
    if (vps.authType === 'password') {
      const runtime = getRuntime();
      runtime.commandStatus[commandId] = 'running';
      setRuntime(runtime);
      pushHistory({ kind: 'command', name: `${cmd.name}:${targetId}`, refId: commandId, tab, status: 'running' });
      runRemoteCommandSsh2(vps, cmd.command, tab, `${cmd.name}:${targetId}`, commandId);
    } else {
      spawnTracked('ssh', buildSshArgs(vps, cmd.command), { cwd: root, windowsHide: true }, { runId, type: 'command', tab, refId: commandId, label: `${cmd.name}:${targetId}` });
    }
  }

  return { ok: true };
}

function stopCommandReal(commandId) {
  const runtime = getRuntime();
  const runIds = runtime.commandRuns[commandId] || [];
  runIds.forEach((runId) => {
    const proc = runtime.processes[runId];
    if (proc?.pid) killPid(proc.pid);
  });
  runtime.commandStatus[commandId] = 'stopping';
  setRuntime(runtime);
  pushHistory({ kind: 'command', name: `stop:${commandId}`, refId: commandId, status: 'stopping' });
  streamEvent({ type: 'status', entityType: 'command', id: commandId, status: 'stopping', runCount: runIds.length });
  streamEvent({ type: 'toast', level: 'info', message: `Đang dừng command ${commandId}` });
  return { ok: true, count: runIds.length };
}

function startTunnelReal(tunnelId) {
  const tunnel = getTunnels().find((x) => x.id === tunnelId);
  if (!tunnel) throw new Error('Không tìm thấy tunnel');
  const vps = getVps().find((x) => x.id === tunnel.target);
  if (!vps) throw new Error('Không tìm thấy target VPS');
  const runtime = getRuntime();
  if (runtime.tunnels[tunnelId] && isAlive(runtime.tunnels[tunnelId].pid)) return { ok: true, message: 'Tunnel đang chạy' };

  const runId = `tunnel-${tunnelId}-${Date.now()}`;
  const tab = `tunnel-${tunnelId}`;
  const spec = `${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort}`;
  appendLog(tab, `$ ssh -N -${tunnel.type} ${spec} ${vps.user}@${vps.host} -p ${vps.port}\n`);
  const args = ['-N', `-${tunnel.type}`, spec, '-p', String(vps.port || 22)];
  if (vps.sshKey) args.push('-i', vps.sshKey);
  args.push(`${vps.user}@${vps.host}`);
  const child = spawnTracked('ssh', args, { cwd: root, windowsHide: true }, { runId, type: 'tunnel', tab, refId: tunnelId, label: tunnel.name });
  return { ok: true, pid: child.pid };
}

function stopTunnelReal(tunnelId) {
  const runtime = getRuntime();
  const current = runtime.tunnels[tunnelId];
  if (!current?.pid) return { ok: true, message: 'Tunnel chưa chạy' };
  killPid(current.pid);
  runtime.tunnelStatus[tunnelId] = 'stopping';
  setRuntime(runtime);
  pushHistory({ kind: 'tunnel', name: `stop:${tunnelId}`, refId: tunnelId, status: 'stopping' });
  streamEvent({ type: 'status', entityType: 'tunnel', id: tunnelId, running: false, pid: current.pid, status: 'stopping' });
  streamEvent({ type: 'toast', level: 'info', message: `Đang dừng tunnel ${tunnelId}` });
  return { ok: true };
}

function saveEntity(listGetter, listSetter, body) {
  const list = listGetter();
  const item = { ...body, id: sanitizeId(body.id || `${Date.now()}`) };
  const index = list.findIndex((x) => x.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
  listSetter(list);
  return item;
}

function deleteEntity(listGetter, listSetter, id) {
  listSetter(listGetter().filter((x) => x.id !== id));
}

function sshBinaryExists() {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-V'], { windowsHide: true });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', () => done(false));
    child.on('exit', () => done(true));
  });
}

async function validateSshKey(keyPath) {
  if (!keyPath) return { exists: false };
  try {
    const stat = fs.statSync(keyPath);
    return { exists: stat.isFile() };
  } catch {
    return { exists: false };
  }
}

function testSshConnection({ host, user, port, sshKey }) {
  return new Promise(async (resolve) => {
    const hasSsh = await sshBinaryExists();
    if (!hasSsh) {
      resolve({ ok: false, code: 'ENOENT', error: 'ssh not found in PATH' });
      return;
    }

    const vps = { host, user, port, sshKey };
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...buildSshArgs(vps, 'echo ok')];
    const child = spawn('ssh', args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => resolve({ ok: false, code: 'SPAWN_ERROR', error: error.message }));
    child.on('exit', (code) => {
      resolve({ ok: code === 0 && stdout.includes('ok'), code, stdout, stderr });
    });
  });
}

async function testSshConnectionAny({ host, user, port, sshKey, authType, password }) {
  const vps = normalizeVpsAuth({ host, user, port, sshKey, authType, password });
  const result = await execRemoteCommandSsh2(vps, 'echo ok');
  if (result.ok) return { ok: true, code: 0 };
  if (vps.authType === 'password') return { ok: false, code: result.code, error: result.error };
  const cliResult = await testSshConnection({ host, user, port, sshKey });
  if (!cliResult.ok && /bad permissions|UNPROTECTED PRIVATE KEY FILE/i.test(String(cliResult.stderr || cliResult.error || ''))) {
    return { ...cliResult, error: `${cliResult.error || cliResult.stderr || 'SSH failed'}. File key đang quá mở quyền trên Windows.` };
  }
  return cliResult;
}

async function repairWindowsKeyPermissions(keyPath) {
  if (!keyPath) return { ok: false, error: 'Thiếu keyPath' };
  if (process.platform !== 'win32') return { ok: false, error: 'Chỉ hỗ trợ trên Windows' };
  if (!fs.existsSync(keyPath)) return { ok: false, error: 'Key file không tồn tại' };
  const run = (args) => new Promise((resolve) => {
    const child = spawn('icacls', args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, stderr }));
  });
  const r1 = await run([keyPath, '/inheritance:r']);
  if (!r1.ok) return { ok: false, error: r1.stderr || 'Không thể tắt inheritance' };
  const r2 = await run([keyPath, '/grant:r', `${process.env.USERNAME}:R`]);
  if (!r2.ok) return { ok: false, error: r2.stderr || 'Không thể grant quyền cho user hiện tại' };
  const r3 = await run([keyPath, '/remove:g', 'Users', 'Authenticated Users', 'Everyone']);
  return r3.ok ? { ok: true } : { ok: false, error: r3.stderr || 'Không thể remove group permissions' };
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(root, decodeURIComponent(urlPath));
  if (!filePath.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' });

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return sendJson(res, 404, { error: 'Not found' });
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return sendJson(res, 500, { error: 'Read failed' });
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${webPort}`);

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const vps = await Promise.all(getVps().map(enrichVps));
        const runtime = getRuntime();
        sendJson(res, 200, { vps, commands: getCommands(), tunnels: getTunnels(), runtime });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        sendJson(res, 200, { log: tailLog(url.searchParams.get('tab') || 'main') });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/ports/check') {
        const port = Number(url.searchParams.get('port') || 0);
        sendJson(res, 200, { port, open: await checkPort(port) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/ssh/validate-key') {
        const body = await parseBody(req);
        sendJson(res, 200, await validateSshKey(body.keyPath));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/ssh/test') {
        const body = await parseBody(req);
        sendJson(res, 200, await testSshConnectionAny(body));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/ssh/fix-key-permissions') {
        const body = await parseBody(req);
        sendJson(res, 200, await repairWindowsKeyPermissions(body.keyPath));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/vps') {
        const body = normalizeVpsAuth(await parseBody(req));
        sendJson(res, 200, { item: await enrichVps(saveEntity(getVps, setVps, body)) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/commands') {
        sendJson(res, 200, { item: saveEntity(getCommands, setCommands, await parseBody(req)) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tunnels') {
        sendJson(res, 200, { item: saveEntity(getTunnels, setTunnels, await parseBody(req)) });
        return;
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/vps/')) {
        deleteEntity(getVps, setVps, sanitizeId(url.pathname.split('/').pop()));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/commands/')) {
        deleteEntity(getCommands, setCommands, sanitizeId(url.pathname.split('/').pop()));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/tunnels/')) {
        const id = sanitizeId(url.pathname.split('/').pop());
        stopTunnelReal(id);
        deleteEntity(getTunnels, setTunnels, id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/commands/') && url.pathname.endsWith('/run')) {
        sendJson(res, 200, await runCommandReal(sanitizeId(url.pathname.split('/')[3])));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/commands/') && url.pathname.endsWith('/stop')) {
        sendJson(res, 200, stopCommandReal(sanitizeId(url.pathname.split('/')[3])));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/tunnels/') && url.pathname.endsWith('/start')) {
        sendJson(res, 200, startTunnelReal(sanitizeId(url.pathname.split('/')[3])));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/tunnels/') && url.pathname.endsWith('/stop')) {
        sendJson(res, 200, stopTunnelReal(sanitizeId(url.pathname.split('/')[3])));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/vps/') && url.pathname.endsWith('/connect')) {
        const id = sanitizeId(url.pathname.split('/')[3]);
        const vps = getVps().find((x) => x.id === id);
        if (!vps) throw new Error('Không tìm thấy VPS');
        const tab = `vps-${id}`;
        appendLog(tab, `$ ssh ${vps.user}@${vps.host} -p ${vps.port}\n`);
        pushHistory({ kind: 'vps', name: `connect:${vps.name}`, refId: id, tab, status: 'opened' });
        sendJson(res, 200, { ok: true, tab });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/vps/') && url.pathname.endsWith('/health')) {
        const id = sanitizeId(url.pathname.split('/')[3]);
        sendJson(res, 200, await getVpsHealth(id));
        return;
      }

      serveStatic(req, res);
    } catch (error) {
      streamEvent({ type: 'toast', level: 'error', message: error.message || 'Unexpected error' });
      sendJson(res, 500, { error: error.message || 'Unexpected error' });
    }
  });
}

function startServer(port = webPort) {
  const server = createAppServer();
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`VPS Ops Console running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, createAppServer };



