#!/usr/bin/env node
/*
 * git pre-push 门:推主线前,这棵树必须有一次 **full** verify 全绿(仓级参数见同目录 config.json)。
 *
 * 为什么焊在 git 层(2026-08-19 主人拍板;2026-09-02 Tier 1-B 重挂并接管 Claude 侧合并守卫):
 *   主线在一夜之间收到 6 个没过 full 的外来提交(Codex 线按 AGENTS.md「任务完成即 push」直推),full 当场红 4 步。
 *   Claude 侧的合并守卫(PLAN/.claude/hooks/verify-fresh-before-merge.mjs)只在 Claude Code 会话里生效,且靠解析 shell 文本,
 *   `git fetch origin && git merge x` 这种链式写法直接绕过(2026-09-02 本机复现)。任何工具、任何机器,只要 push 就必经 pre-push。
 *
 * 判据:
 *   .verify-cache/last-run.json 里 mode=full · verdict=pass · 跑的过程树没动 · 工作树干净 · headTree == 要推的那个提交的树。
 *   只拦推到 refs/heads/<mainline> 的更新;推别的分支(pkg/* · claude/* · codex/*)不管;删分支不管。
 *   (verdict=pass 的含义由 verify 链定义:FAIL/NOT-RUN 为 0;KNOWN-RED 不计红 —— 见 scripts/known-red.json。)
 *
 * 输入(git 约定):argv = [remote 名, url];stdin 每行 `<local ref> <local sha> <remote ref> <remote sha>`。
 * 逃生阀:环境变量 ALLOW_UNVERIFIED_PUSH=<原因>(留痕 .verify-cache/push-valve.log;仅主人明令时用)。
 *   `git push --no-verify` 是 git 原生绕过,同样只许主人明令,且不留痕 —— 别用。
 * 内部异常 fail-open(门自己坏了不许卡住正常 push);只有「查到了、且确实没有匹配的 full 绿」才拦。
 *
 * 挂载:`node .githooks/verify-before-push.mjs --install`(package.json prepare 会在 npm install 时自动跑)
 *   = git config core.hooksPath .githooks(仓级配置,所有 worktree 共享;别的机器 / 沙箱只要 npm install 过就挂上)。
 * 自测:npm run test:githooks(verify:steps 链上第 2 步)。
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
const MAINLINE = process.env.PRE_PUSH_MAINLINE || loadConfig().mainline || "main";
const git = (args, cwd) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

// ── --install:把本仓的 hooks 目录指到 .githooks(幂等;不在 git 树里就静默跳过;已指向别处不覆盖)──
if (process.argv.includes("--install")) {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") process.exit(0);
  const cur = git(["config", "--get", "core.hooksPath"]);
  if (cur && cur !== ".githooks") { console.log(`[githooks] core.hooksPath 已是 ${cur},不覆盖;要用本仓的门:git config core.hooksPath .githooks`); process.exit(0); }
  if (cur !== ".githooks") { git(["config", "core.hooksPath", ".githooks"]); console.log("[githooks] core.hooksPath → .githooks(pre-commit S 级门 + pre-push full 门已挂上)"); }
  process.exit(0);
}

/** 判据(曾与 PLAN 合并守卫 verify-fresh-before-merge.mjs 同源)。返回 {ok, why}。 */
export function judge(repoDir, refTree) {
  const file = path.join(repoDir, ".verify-cache", "last-run.json");
  if (!existsSync(file)) return { ok: false, why: `没有 .verify-cache/last-run.json —— 这棵树从没跑过 npm run verify(full)` };
  let rec;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { ok: false, why: `last-run.json 读不出来:${e.message}` }; }
  if (rec.mode !== "full") return { ok: false, why: `最近一次是 ${rec.mode} 档(${rec.at})—— scoped/static 绿不等于全量绿` };
  if (rec.verdict !== "pass") return { ok: false, why: `最近一次 full 是 ${rec.verdict}(${rec.at})` };
  if (rec.treeMoved) return { ok: false, why: `最近一次 full 跑的过程中工作树变了(${rec.at}),结论不锚定任何一棵树` };
  if (rec.dirty !== false) return { ok: false, why: `最近一次 full 跑时工作树不干净(${rec.at})—— 绿的是「HEAD + 未提交改动」,不是任何一个提交` };
  if (!rec.headTree || rec.headTree !== refTree) return { ok: false, why: `最近一次 full 绿的树 ${String(rec.headTree || "?").slice(0, 10)} ≠ 要推的树 ${String(refTree || "?").slice(0, 10)}(${rec.at})—— 跑绿之后又有提交,重跑 full` };
  return { ok: true, why: `full 绿匹配:tree ${rec.headTree.slice(0, 10)} @ ${rec.at}${Array.isArray(rec.knownRed) && rec.knownRed.length ? `(含 ${rec.knownRed.length} 条已知红,见 scripts/known-red.json)` : ""}` };
}

function main() {
  let top = git(["rev-parse", "--show-toplevel"]);
  if (!top) process.exit(0); // 不是 git 树?让 git 自己去报
  top = top.replace(/\\/g, "/");
  let raw = "";
  try { raw = process.stdin.isTTY ? "" : readFileSync(0, "utf8"); } catch { raw = ""; }
  const updates = raw.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4);
  const gated = updates.filter(([, lsha, rref]) => rref === `refs/heads/${MAINLINE}` && !/^0+$/.test(lsha));
  if (gated.length === 0) process.exit(0);

  const valve = (process.env.ALLOW_UNVERIFIED_PUSH || "").trim();
  for (const [lref, lsha, rref] of gated) {
    const refTree = git(["rev-parse", `${lsha}^{tree}`], top);
    if (!refTree) continue; // 解析不出 → 让 git 自己去报错
    const v = judge(top, refTree);
    if (v.ok) { process.stderr.write(`[pre-push] ✓ ${v.why}\n`); continue; }
    if (valve) {
      try {
        mkdirSync(path.join(top, ".verify-cache"), { recursive: true });
        appendFileSync(path.join(top, ".verify-cache", "push-valve.log"), `${new Date().toISOString()}\t${lref}→${rref}\t${lsha}\t${valve.replace(/\s+/g, " ").slice(0, 200)}\n`);
      } catch { /* 留痕失败不影响放行 */ }
      process.stderr.write(`[pre-push] 🅿️ 逃生阀 ALLOW_UNVERIFIED_PUSH 已消费(${valve.slice(0, 80)};留痕 .verify-cache/push-valve.log)\n`);
      continue;
    }
    process.stderr.write(
      `🚫 [pre-push] 推 ${lref.replace(/^refs\/heads\//, "")} → 主线 ${MAINLINE} 被拦:${v.why}\n` +
      `   仓:${top}\n` +
      `   规矩(主人 2026-08-17 拍板 Q2A;2026-08-19 焊到 git 层):推主线前,要推的那个提交必须有一次 **full** 档全量绿(scoped/static 只买内循环速度)。\n` +
      `   怎么做:在最后一次提交之后、工作树干净时跑 npm run verify(= full),绿了再推;\n` +
      `          本环境跑不了 full(没浏览器 / 没依赖)→ 推到 codex/<topic> 或 pkg/<名> 分支(不拦),由能跑 full 的机器合并进主线;\n` +
      `          主人明令凭证据链推 → ALLOW_UNVERIFIED_PUSH="<原因>" git push …(会留痕);--no-verify 不留痕,别用。\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && /verify-before-push\.mjs$/.test(process.argv[1]) && !process.argv.includes("--as-module")) main();
