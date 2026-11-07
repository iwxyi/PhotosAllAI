import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const executable = createRequire(new URL('../../package.json', import.meta.url))('electron');
const fixture = fileURLToPath(new URL('./startup-probe.cjs', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [fixture], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
console.log(JSON.stringify({ ...result, pid: child.pid, mainScriptStarted: stdout.includes('main-script-started'), appReady: stdout.includes('app-ready'), stdout: stdout.trim(), stderr: stderr.trim() }));
if (result.code !== 0 || !stdout.includes('app-ready')) process.exitCode = 1;
