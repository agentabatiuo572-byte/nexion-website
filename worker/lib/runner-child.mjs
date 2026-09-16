/* 父进程的 IPC 是存活线。执行器被强杀时，监护进程先终止命令子树再退场。 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const [command, ...args] = process.argv.slice(2);
let child;
let ending = false;
let stopWork;
let commandClosed = false;
let markClosed;
const closed = new Promise(resolve => { markClosed = resolve; });
async function finish(code) {
  process.exitCode = code;
  if (process.connected) {
    await new Promise(resolve => { process.send('stopped', () => resolve()); });
    if (process.connected) process.disconnect();
  }
}
async function stop() {
  if (stopWork || ending) return stopWork;
  ending = true;
  stopWork = (async () => {
    let treeStopped = !child?.pid;
    // Keep the cleanup owner alive while a transient OS failure prevents termination.
    while (child?.pid && !commandClosed) {
      try {
        if (process.platform === 'win32') await new Promise((resolve, reject) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
          killer.once('error', reject);
          killer.once('close', code => code === 0 ? resolve() : reject(new Error('command tree termination not confirmed')));
        });
        else process.kill(-child.pid, 'SIGKILL');
        treeStopped = true;
        await closed;
      } catch { if (!commandClosed) await delay(500); }
    }
    // A failed tree kill followed by root exit leaves descendant ownership unknown.
    // Keep the watchdog and its IPC; never retry a PID that may have been reused.
    if (!treeStopped) return;
    await finish(130);
  })();
  return stopWork;
}
process.once('disconnect', stop);
function start() {
  if (ending || !process.connected || child) return;
  child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 127; });
  child.once('close', (code) => {
    commandClosed = true; markClosed();
    if (ending) return;
    ending = true;
    void finish(process.exitCode ?? code ?? 1);
  });
}
// 只有父进程持久化监护 PID 成功后才启动命令，封住磁盘写失败却已开始部署的窗口。
process.on('message', (message) => { if (message === 'start') start(); else if (message === 'stop') void stop(); });
if (!process.connected) process.exitCode = 130;
