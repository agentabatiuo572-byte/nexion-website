// verify 开跑第一件事:退出码文件置红。**由 npm script 作为独立进程先跑**,不是 verify.mjs 的 import——
// ESM 的 link 阶段先于任何模块体执行,门模块只要有语法错,整棵图一个字节都没跑,
// 写在 verify.mjs 里(哪怕是第一个 import)的「置 2」永远轮不到,退出码文件就留着上一次的绿。
// 红测:同构装置里 import 在前 + 后一个模块语法错 → 文件仍 0;拆成独立进程后 → 2。
import { writeFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
writeFileSync(ROOT + '.verify-exit.code', '2');
