#!/usr/bin/env node
/* pre-commit S 级门红测(node --test;npm run test:githooks)。
 * 临时仓 + 真实 git commit(经 core.hooksPath 触发 shim → node),同时证明「真会拦」和「不误拦」。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HOOK_DIR, "guard-mainline-commit.mjs");
const CFG = JSON.parse(readFileSync(join(HOOK_DIR, "config.json"), "utf8"));
const MAINLINE = CFG.mainline;
const S_MAX = CFG.sMaxFiles;
const base = mkdtempSync(join(tmpdir(), "pre-commit-gate-")).replace(/\\/g, "/");
const repo = `${base}/repo`;
const bare = `${base}/origin.git`;
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
execFileSync("git", ["init", "--bare", "-q", "-b", MAINLINE, bare]);
git("init", "-q", "-b", MAINLINE);
git("config", "user.email", "t@t"); git("config", "user.name", "t");
git("remote", "add", "origin", bare);
writeFileSync(`${repo}/a.txt`, "a\n"); git("add", "."); git("commit", "-q", "-m", "A");
git("push", "-q", "origin", MAINLINE);
git("fetch", "-q", "origin");
// 直接调门(不经 git):stdin 无关,门自己查暂存 + 分支
const run = (env = {}) => {
  const r = spawnSync(process.execPath, [HOOK], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, err: r.stderr || "" };
};
const stage = (n, prefix = "f") => { for (let i = 0; i < n; i++) writeFileSync(`${repo}/${prefix}${i}.txt`, `${i}\n`); git("add", "."); };
process.on("exit", () => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

test("主线上 S 级(暂存 1 文件 · 无提案 · 无未推)→ 放行", () => {
  stage(1);
  const r = run();
  assert.equal(r.code, 0, r.err); assert.match(r.err, /✓ 主线 .* S 级直提/);
  git("reset", "-q");
});
test(`暂存 ${S_MAX + 1} 个文件(> S 级上限 ${S_MAX})→ 拦`, () => {
  stage(S_MAX + 1);
  const r = run();
  assert.equal(r.code, 1); assert.match(r.err, new RegExp(`暂存了 ${S_MAX + 1} 个文件`));
  git("reset", "-q");
});
test("暂存里有 docs/changes/ 提案 → 拦", () => {
  mkdirSync(`${repo}/docs/changes`, { recursive: true });
  writeFileSync(`${repo}/docs/changes/2026-09-02-x.md`, "# x\n"); git("add", ".");
  const r = run();
  assert.equal(r.code, 1); assert.match(r.err, /docs\/changes\//);
  git("reset", "-q");
});
test("主线上已有未推的提交 → 拦(S 级 = 提交即推)", () => {
  writeFileSync(`${repo}/b.txt`, "b\n"); git("add", "."); git("commit", "-q", "-m", "B"); // 本地领先 origin 1 笔
  stage(1, "c");
  const r = run();
  assert.equal(r.code, 1); assert.match(r.err, /1 笔还没推的提交/);
  git("reset", "-q");
  git("push", "-q", "origin", MAINLINE); git("fetch", "-q", "origin"); // 复位:推上去
});
test("非主线分支(pkg/x)上不管,哪怕暂存很多文件", () => {
  git("checkout", "-q", "-b", "pkg/x");
  stage(S_MAX + 3, "p");
  assert.equal(run().code, 0);
  git("reset", "-q"); git("checkout", "-q", MAINLINE);
});
test("逃生阀 ALLOW_MAIN_COMMIT=<原因> → 放行并留痕", () => {
  stage(S_MAX + 1, "v");
  const r = run({ ALLOW_MAIN_COMMIT: "主人明令:红测" });
  assert.equal(r.code, 0); assert.match(r.err, /逃生阀 ALLOW_MAIN_COMMIT 已消费/);
  const log = readFileSync(`${repo}/.verify-cache/commit-valve.log`, "utf8");
  assert.match(log, /主人明令:红测/); assert.match(log, new RegExp(MAINLINE));
  git("reset", "-q");
});
test("PRE_COMMIT_MAINLINE 覆盖 config.json:改守别的分支名后,原主线不再被拦", () => {
  stage(S_MAX + 1, "o");
  assert.equal(run({ PRE_COMMIT_MAINLINE: "other" }).code, 0);
  git("reset", "-q");
});
test("端到端:core.hooksPath 指到 .githooks 后,真的 git commit 会被 pre-commit 拦;S 级照常提交", () => {
  mkdirSync(`${repo}/.githooks`, { recursive: true });
  for (const f of ["pre-commit", "guard-mainline-commit.mjs", "config.json"]) writeFileSync(`${repo}/.githooks/${f}`, readFileSync(join(HOOK_DIR, f)));
  git("config", "core.hooksPath", ".githooks");
  if (process.platform !== "win32") execFileSync("chmod", ["+x", `${repo}/.githooks/pre-commit`]);
  git("add", ".githooks"); git("commit", "-q", "-m", "hooks"); git("push", "-q", "origin", MAINLINE); git("fetch", "-q", "origin");
  stage(S_MAX + 1, "e");
  const blocked = spawnSync("git", ["-C", repo, "commit", "-q", "-m", "too big"], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0, `应被 pre-commit 拦,却 exit ${blocked.status}:${blocked.stderr}`);
  assert.match(blocked.stderr, /\[pre-commit\]/);
  git("reset", "-q");
  writeFileSync(`${repo}/small.txt`, "s\n"); git("add", "small.txt");
  const ok = spawnSync("git", ["-C", repo, "commit", "-q", "-m", "small"], { encoding: "utf8" });
  assert.equal(ok.status, 0, `S 级应放行:${ok.stderr}`);
});
