/* 父进程的 IPC 是存活线。执行器被强杀时，监护进程先终止命令子树再退场。 */
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
let child;
let ending = false;
async function stop() {
  if (ending) return;
  ending = true;
  if (process.platform === 'win32') {
    if (child?.pid) await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
    process.exitCode = 130;
    if (process.connected) process.disconnect();
  } else {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exitCode = 130; }
  }
}
process.once('disconnect', stop);
function start() {
  if (ending || !process.connected || child) return;
  child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', (error) => { ending = true; console.error(error.message); process.exitCode = 127; if (process.connected) process.disconnect(); });
  child.once('close', (code) => {
    if (ending) return;
    ending = true;
    process.exitCode = code ?? 1;
    if (process.connected) process.disconnect();
  });
}
// 只有父进程持久化监护 PID 成功后才启动命令，封住磁盘写失败却已开始部署的窗口。
process.once('message', (message) => { if (message === 'start') start(); });
if (!process.connected) process.exitCode = 130;
