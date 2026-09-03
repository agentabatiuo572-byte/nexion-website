#!/usr/bin/env node
/*
 * git pre-commit 门:在主线分支上只许 S 级直提(主人 2026-08-17 分档规矩),M/L 级走 pkg/<字母>-<短名> 分支。
 *
 * 为什么焊在 git 层(Tier 1-B,2026-09-02):
 *   原 PLAN/.claude/hooks/guard-package-branch.mjs 从 shell 命令**文本**里猜工作目录(-C → cd → hook 进程 cwd),
 *   而 hook 进程的 cwd 恒为 PLAN 根 → 最常见的裸 `git commit -m x`(Bash cwd 已在仓内)整条不响(2026-09-02 本机复现)。
 *   pre-commit 拿到的是真实分支 + 真实暂存清单,不猜;任何工具 / 任何机器 / 手工提交都必经。
 *
 * S 级判据(全部满足才放行;与旧守卫同源,只把「工作树改动数」换成「暂存文件数」——提交只带暂存的东西):
 *   ① 暂存文件 ≤ sMaxFiles(config.json,默认 5);
 *   ② 暂存里没有 docs/changes/ 下的文件(有提案 / plan / tester 报告 = M/L);
 *   ③ 主线上没有还没推的提交(S 级 = 一次提交、提交即推;多笔就是 M/L)。
 *   --amend 在 pre-commit 里分不出来,不判(旧守卫判过;git 层换成 pre-push 的树匹配兜底)。
 * 逃生阀:环境变量 ALLOW_MAIN_COMMIT=<原因>(留痕 .verify-cache/commit-valve.log;合并后的收尾提交、主人明令时用)。
 *   `git commit --no-verify` 是 git 原生绕过,不留痕 —— 别用。
 * 内部异常 fail-open(门自己坏了不许卡住正常提交);只有「查到了、且确实不是 S 级」才拦。
 * 自测:npm run test:githooks(.githooks/guard-mainline-commit.test.mjs)。
 */
"use strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function loadConfig() {
  try { return JSON.parse(readFileSync(path.join(HERE, "config.json"), "utf8")); } catch { return {}; }
}
const CFG = loadConfig();
const MAINLINE = process.env.PRE_COMMIT_MAINLINE || CFG.mainline || "main";
const S_MAX_FILES = Number(process.env.PRE_COMMIT_S_MAX_FILES || CFG.sMaxFiles || 5);

const git = (args, cwd) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

/** S 级判据:返回 null = 是 S 级(放行);否则返回一组「为什么不是 S」的理由。 */
export function sLevelBlockers(repoDir, branch) {
  const reasons = [];
  const staged = (git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTD"], repoDir) || "")
    .split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, "/"));
  if (staged.length > S_MAX_FILES) reasons.push(`暂存了 ${staged.length} 个文件(S 级上限 ${S_MAX_FILES})`);
  const proposals = staged.filter((f) => /(^|\/)docs\/changes\//.test(f));
  if (proposals.length) reasons.push(`暂存里有 docs/changes/ 下的文件(${proposals[0]}${proposals.length > 1 ? " 等" : ""})—— 有提案 / plan / tester 报告 = M/L 级`);
  const upstream = `origin/${branch}`;
  if (git(["rev-parse", "--verify", "--quiet", upstream], repoDir)) {
    const unpushed = Number(git(["rev-list", "--no-merges", "--count", `${upstream}..HEAD`], repoDir) || "0");
    if (unpushed > 0) reasons.push(`主线上已有 ${unpushed} 笔还没推的提交 —— S 级 = 一次提交、提交即推;多笔就是 M/L,走分支`);
  }
  return reasons.length ? reasons : null;
}

function main() {
  let top = git(["rev-parse", "--show-toplevel"]);
  if (!top) process.exit(0);
  top = top.replace(/\\/g, "/");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch !== MAINLINE) process.exit(0); // detached / 非主线 → 不管
  const blockers = sLevelBlockers(top, branch);
  if (!blockers) { process.stderr.write(`[pre-commit] ✓ 主线 ${MAINLINE} 上的 S 级直提(暂存 ≤${S_MAX_FILES} 文件 · 无提案 · 无未推提交)\n`); process.exit(0); }
  const valve = (process.env.ALLOW_MAIN_COMMIT || "").trim();
  if (valve) {
    try {
      mkdirSync(path.join(top, ".verify-cache"), { recursive: true });
      appendFileSync(path.join(top, ".verify-cache", "commit-valve.log"), `${new Date().toISOString()}\t${branch}\t${valve.replace(/\s+/g, " ").slice(0, 200)}\t${blockers.join(" | ")}\n`);
    } catch { /* 留痕失败不影响放行 */ }
    process.stderr.write(`[pre-commit] 🅿️ 逃生阀 ALLOW_MAIN_COMMIT 已消费(${valve.slice(0, 80)};留痕 .verify-cache/commit-valve.log)\n`);
    process.exit(0);
  }
  process.stderr.write(
    `🚫 [pre-commit] 当前在主线 \`${branch}\` 上,这笔提交不是 S 级,禁止直接提交。\n` +
    `   仓:${top}\n` + blockers.map((r) => `   · ${r}\n`).join("") + `\n` +
    `分档规矩(主人 2026-08-17 拍板;2026-09-02 焊到 git 层):S 级(1 次提交 ≤${S_MAX_FILES} 文件、无 docs/changes 提案、提交即推)可直提主线;\n` +
    `M/L 级走自己的分支 pkg/<字母>-<短名>,审计来回留在分支上,做完合并回主线再删分支。\n` +
    `怎么做:node D:/WORKS/PLAN/scripts/pkg.mjs open <字母>-<短名>(建分支;未提交改动跟着过去)→ 分支上提交 → pkg.mjs close 合并。\n` +
    `确实要直接提主线(如合并后的收尾提交)→ ALLOW_MAIN_COMMIT="<原因>" git commit …(会留痕);--no-verify 不留痕,别用。\n`,
  );
  process.exit(1);
}

if (process.argv[1] && /guard-mainline-commit\.mjs$/.test(process.argv[1]) && !process.argv.includes("--as-module")) main();
