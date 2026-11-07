import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
const executable = createRequire(new URL('../../package.json', import.meta.url))('electron');
const fixture = fileURLToPath(new URL('./quicklook-exit.cjs', import.meta.url));
const results = [];
for (const mode of process.argv.slice(2)) {
  const root = mkdtempSync(path.join(tmpdir(), 'photo-ql-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [fixture, mode, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const result = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ mode, pid: child.pid, root, code, signal })));
  clearTimeout(timer);
  writeFileSync(root + '/stderr.log', stderr);
  const trace = readFileSync(root + '/trace.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  result.last = trace.slice(-3); result.completed = trace.filter(line => /thumbnail-(done|error)/.test(line.phase)).length;
  results.push(result); console.log(JSON.stringify(result));
}
console.log(JSON.stringify({ results }));
