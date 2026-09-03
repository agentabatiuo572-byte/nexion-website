#!/usr/bin/env node
/* pre-push full 门红测(node --test;npm run test:githooks,verify:steps 链上第 2 步)。
 * 判据必须同时证明「真会拦」和「不误拦」:临时仓 + 构造 .verify-cache/last-run.json,一个字节都不碰线上工程。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HOOK_DIR, "verify-before-push.mjs");
const MAINLINE = JSON.parse(readFileSync(join(HOOK_DIR, "config.json"), "utf8")).mainline;
const base = mkdtempSync(join(tmpdir(), "pre-push-gate-")).replace(/\\/g, "/");
const repo = `${base}/repo`;
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q", "-b", MAINLINE);
git("config", "user.email", "t@t"); git("config", "user.name", "t");
writeFileSync(`${repo}/a.txt`, "a\n"); git("add", "."); git("commit", "-q", "-m", "A");
const shaA = git("rev-parse", "HEAD"), treeA = git("rev-parse", "HEAD^{tree}");
const ZERO = "0".repeat(40);
const lastRun = (over = {}) => {
  mkdirSync(`${repo}/.verify-cache`, { recursive: true });
  writeFileSync(`${repo}/.verify-cache/last-run.json`, JSON.stringify({ mode: "full", verdict: "pass", treeMoved: false, dirty: false, headTree: treeA, at: "2026-08-19T00:00:00Z", ...over }));
};
const push = (line, env = {}) => {
  const r = spawnSync(process.execPath, [HOOK, "origin", "https://example.invalid/x.git"], { cwd: repo, input: line, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, err: r.stderr || "" };
};
const toMain = (sha) => `refs/heads/${MAINLINE} ${sha} refs/heads/${MAINLINE} ${ZERO}\n`;
process.on("exit", () => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

test("从没跑过 full(无 last-run.json)→ 拦", () => {
  const r = push(toMain(shaA));
  assert.equal(r.code, 1); assert.match(r.err, /从没跑过 npm run verify/);
});
test("推别的分支(pkg/*)不拦,哪怕从没跑过 full", () => {
  assert.equal(push(`refs/heads/pkg/x ${shaA} refs/heads/pkg/x ${ZERO}\n`).code, 0);
});
test("删远端主线分支(local sha 全 0)不拦", () => {
  assert.equal(push(`(delete) ${ZERO} refs/heads/${MAINLINE} ${shaA}\n`).code, 0);
});
test("full 绿且树匹配 → 放行", () => {
  lastRun();
  const r = push(toMain(shaA));
  assert.equal(r.code, 0); assert.match(r.err, /✓ full 绿匹配/);
});
test("full 绿含已知红(knownRed 非空)→ 放行并在 ✓ 行点名条数", () => {
  lastRun({ knownRed: [{ step: "test:cross-repo" }] });
  const r = push(toMain(shaA));
  assert.equal(r.code, 0); assert.match(r.err, /含 1 条已知红/);
});
test("最近一次是 static 档 → 拦", () => { lastRun({ mode: "static" }); assert.match(push(toMain(shaA)).err, /static 档/); assert.equal(push(toMain(shaA)).code, 1); });
test("最近一次 full 是 fail → 拦", () => { lastRun({ verdict: "fail" }); assert.equal(push(toMain(shaA)).code, 1); });
test("跑 full 时工作树不干净 → 拦", () => { lastRun({ dirty: true }); assert.equal(push(toMain(shaA)).code, 1); });
test("跑 full 过程中树动了 → 拦", () => { lastRun({ treeMoved: true }); assert.equal(push(toMain(shaA)).code, 1); });
test("绿的树 ≠ 要推的树(绿了之后又提交)→ 拦", () => {
  lastRun();
  writeFileSync(`${repo}/b.txt`, "b\n"); git("add", "."); git("commit", "-q", "-m", "B");
  const shaB = git("rev-parse", "HEAD");
  const r = push(toMain(shaB));
  assert.equal(r.code, 1); assert.match(r.err, /≠ 要推的树/);
});
test("逃生阀 ALLOW_UNVERIFIED_PUSH=<原因> → 放行并留痕", () => {
  const shaB = git("rev-parse", "HEAD");
  const r = push(toMain(shaB), { ALLOW_UNVERIFIED_PUSH: "主人明令:红测" });
  assert.equal(r.code, 0); assert.match(r.err, /逃生阀 ALLOW_UNVERIFIED_PUSH 已消费/);
  const log = readFileSync(`${repo}/.verify-cache/push-valve.log`, "utf8");
  assert.match(log, /主人明令:红测/); assert.match(log, new RegExp(shaB));
});
test("PRE_PUSH_MAINLINE 覆盖 config.json:改守别的分支名后,原主线名不再被拦", () => {
  rmSync(`${repo}/.verify-cache`, { recursive: true, force: true });
  assert.equal(push(toMain(shaA), { PRE_PUSH_MAINLINE: "other" }).code, 0);
  assert.equal(push(`refs/heads/other ${shaA} refs/heads/other ${ZERO}\n`, { PRE_PUSH_MAINLINE: "other" }).code, 1);
});
test("--install:core.hooksPath → .githooks,幂等,不覆盖别人的值", () => {
  const install = () => spawnSync(process.execPath, [HOOK, "--install"], { cwd: repo, encoding: "utf8" });
  assert.equal(install().status, 0);
  assert.equal(git("config", "--get", "core.hooksPath"), ".githooks");
  assert.equal(install().status, 0);
  assert.equal(git("config", "--get", "core.hooksPath"), ".githooks");
  git("config", "core.hooksPath", ".other");
  const r = install();
  assert.equal(r.status, 0); assert.match(r.stdout, /不覆盖/);
  assert.equal(git("config", "--get", "core.hooksPath"), ".other");
});
test("端到端:core.hooksPath 指到 .githooks 后,真的 git push 会被 pre-push 拦(dry-run 也触发)", () => {
  // 造 bare origin,把 .githooks 放进仓里,让 git 自己去跑 shim → node
  const bare = `${base}/origin.git`;
  execFileSync("git", ["init", "--bare", "-q", "-b", MAINLINE, bare]);
  git("remote", "add", "origin", bare);
  mkdirSync(`${repo}/.githooks`, { recursive: true });
  for (const f of ["pre-push", "verify-before-push.mjs", "config.json"]) writeFileSync(`${repo}/.githooks/${f}`, readFileSync(join(HOOK_DIR, f)));
  git("config", "core.hooksPath", ".githooks");
  if (process.platform !== "win32") execFileSync("chmod", ["+x", `${repo}/.githooks/pre-push`]);
  rmSync(`${repo}/.verify-cache`, { recursive: true, force: true }); // 从没跑过 full 的状态
  const r = spawnSync("git", ["-C", repo, "push", "--dry-run", "origin", MAINLINE], { encoding: "utf8" });
  assert.notEqual(r.status, 0, `push 应被 pre-push 拦,却 exit ${r.status}:${r.stderr}`);
  assert.match(r.stderr, /\[pre-push\]/);
  assert.match(r.stderr, /从没跑过 npm run verify/);
  const ok = spawnSync("git", ["-C", repo, "push", "--dry-run", "origin", `${MAINLINE}:refs/heads/pkg/free`], { encoding: "utf8" });
  assert.equal(ok.status, 0, `推非主线应放行:${ok.stderr}`);
});
