// Run the PearPass web app (Vite, port 3000) and backend API (port 3001) together.
// Usage: npm run dev
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const procs = [
  { name: 'frontend', cmd: 'npx', args: ['vite', '--config', 'vite.config.ts'] },
  { name: 'backend', cmd: 'npx', args: ['tsx', 'src/server.ts'] },
].map(({ name, cmd, args }) => {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  p.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown();
  });
  return p;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);