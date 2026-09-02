# T21/T22 发布流水线 独立验收报告(黑盒 · 2026-09-01)

- **验收对象**:PRD `NexGrid_官网后台PRD_v1.0.md` [FEAT-CON13] 全部 + §5.4;plan `2026-08-31-website-admin.plan.md` T21 / T22 节
- **验收方**:独立 tester(未参与实现)
- **环境**:`D:\WORKS\PLAN\.wt\w-console`(分支 `pkg/w-publish`),`npx wrangler dev --port 8804 --persist-to .wrangler-t21`;迁移 0001–0005 已 apply;`/admin/setup`(token `dev-setup-token`)后登录
- **执行方式**:全部经 HTTP API 与真浏览器(Playwright)实测;真跑了 **4 次完整发布**(gates 步骤各 ~350s),外加 SQL 直改锁状态的故障注入
- **判决**:🔴 **不可签字**。3 条 P0(其中 2 条是「零门上线」的直接可复现路径,1 条是「门红后线上就是坏内容」),4 条 P1,8 条 P2。

---

## 一、逐 AC 结论

| AC | 结论 | 一句话 |
|---|---|---|
| A 前置校验拦截(E1) | **PASS** | 4 类红项全列 + 每项「去修复」可跳 + 发布按钮禁用;绕过 UI 直接 `POST /api/publish` → 409 `preflight-failed`,**零新版本、零锁** |
| B 成功发布全链 | **PASS** | 四步逐步推进(materialize 0.1s / gates 350.3s / build 3.1s / swap 0.0s),v11 变 live、旧 live 归档;**HTTP 实测站产物真的换成新文案** |
| C 门红保旧版 | **FAIL(P0-3 + P1-1 + P1-2)** | 版本确实 `failed`、草稿原样保留、大白话+门名到位;但**站产物在门判红之前就已被换成坏内容**,门红后线上停在坏内容上;且失败态下「查看原始日志」根本不渲染、控制台整体 404 |
| D 回滚 | **PASS** | 生成**新版本号** v16(v11 仍 archived,未被复活)、理由必填(<8 字 400)、**四步门链全跑**(gates 347.2s);站产物内容回到第一版 |
| E 并发与自愈 | **PASS** | 发布中再发一次 → 409 `publish-in-progress`;锁 `expires_at` 拨到过去后 `GET /api/publish/status` 自动标 failed + 清锁 + 可立即重发 |
| F 取消 | **PARTIAL(P1-4)** | 排队态显示「排队中…」+ 取消出口、取消成功;已有步骤**完成**时 409 拒绝 ✅;但步骤处于 **running** 时仍可取消(PRD ⑥ 明写「仅排队态」) |
| G 无绕门路径 | 🔴 **FAIL(P0-1 / P0-2)** | 28 条猜测路由全 404、6 条未认证入口全 401、无锁/冒名版本号全 409 ✅;但**持锁方可以直接报 `swap ok` 跳过全部门**,**过期锁也照收** |
| H 编码损坏防护 | **PASS** | U+FFFD 可存草稿、preflight 报 `encoding-damage`、`POST /api/publish` 409 不进流水线 |
| I 审计 | **PASS(带瑕疵)** | `config.publish` / `.live` / `.failed` / `.cancel` / `config.rollback` 各有行,理由挂在发起行;审计无任何变更路由(5 条 404) |

---

## 二、P0(阻断签字)

### P0-1 🔴 状态机零顺序校验:**两次 HTTP 调用即可让版本在「一道门都没跑」的情况下变 live**

`worker/src/publish.ts` 的 `POST /api/publish/step` 只校验三件事:请求体形状、`step` 在枚举内、`versionId` == 当前锁持有的版本。**它从不检查前序步骤是否已 ok**。于是 `step:'swap', status:'ok'` 这一条请求就是「上新」按钮本身。

实测(G-4):

```
POST /api/publish                                  -> 200 {"versionId":2,...}
POST /api/publish/step {versionId:2,step:"swap",status:"ok"}  -> 200 {"ok":true}

结果: versions = v2:live, v1:archived
      publish_steps = []            ← 连「跑过门」的痕迹都没有
      liveVersion = 2,内容 = 未过门的草稿
```

第二形态(G-8,更直观):真执行器正在跑门时抢先上线 ——

```
materialize running -> 200 ; materialize ok -> 200 ; gates running -> 200
POST /api/publish/step {step:"swap",status:"ok"}   -> 200
结果: v13:live,而该版本 publish_steps 里 gates 这行的 status 仍然是 "running"
```

- **违反**:PRD CON13-④「禁止:跳过任何门直接上新(**不存在该 API**)」;plan T21-AC「**不存在绕门发布 API**(路由审计测试)」。
- **审计侧后果**:伪造上线写出的 `config.publish.live` 审计行与正常上线**完全同形**(实测 #9 / #12 / #35 三行),事后无法分辨哪一次过了门。
- **既有测试为什么没抓到**:`worker/test/publish.spec.ts` 的「④ 禁止动作」只测了 ①未知路由 404/405 ②`versionId + 999` 冒名 → 409。**没有一条测「正确的 versionId + 跳过前序步骤」**。断言写了不变量,覆盖面没咬住它。
- **修复方向**:`/step` 必须由 server 推进单向状态机——`running` 只在「前一步 ok」时接受;`swap` 只在 materialize/gates/build 三行都为 `ok` 且同属该 version 时接受。更彻底的做法是 gates 的 `ok` 需要附带可核验凭据(产物哈希 / 门汇总指纹),否则「门过了」永远只是执行器的一句自述。

### P0-2 🔴 `/step` 不看锁的过期时间:**过期锁仍可提交 `swap ok`**,TTL 形同虚设

`/step` 里是 `SELECT version_id FROM publish_lock WHERE id = 1`,**没有 `expires_at` 条件**;而 `/next`、`/status` 都查了。

实测(G-5):把 `publish_lock.expires_at` 用 SQL 拨到 60 秒前,然后 ——

```
POST /api/publish/step {versionId:3,step:"swap",status:"ok"} -> 200
结果: v3:live, v2:archived, 锁被删
```

- **后果**:一个已经超时的僵尸执行器(或超时后才醒过来的 CI 任务)仍能把它那一版推上线。15 分钟 TTL 在**上新**这一步上没有约束力,只在「取锁」和「读状态」上有。
- **修复方向**:`/step` 的锁查询补 `AND expires_at > ?now`,过期即 409。

### P0-3 🔴 **门还在跑,未过门的内容已经在线上;门判红后线上就停在坏内容上**

机制(逐层实测确认):

1. `gates` 步骤跑 `npm run verify`;
2. `verify` 内的 `canvas-geometry` 门会 `execFileSync('npm', ['run','build'])`(`scripts/gate-canvas-geometry.mjs:78`),把 **materialize 之后的新配置**构建进 `dist/`;
3. worker 的 `assets.directory` 就是 `../dist`(`worker/wrangler.jsonc`),**dist 即线上**;
4. 执行器的第 ③ 步 `build` 只跑 `build:console`(组装控制台),第 ④ 步 `swap` 是**纯回报、零动作**。

也就是说 V1-dev 下「原子切换」既不原子也不在最后 —— 真正的内容切换发生在**门的中途**。

AC-C 实测(v12,超长文案):

```
00:54:35  POST /api/publish -> v12
00:55:20  站首页 HTTP 实测已经是未过门的长文案   ← 门才刚开始跑
01:00:38  gates failed(canvas-geometry)
01:00:41  站首页 HTTP 实测 **仍然是**那段坏文案
          curl http://127.0.0.1:8804/ | grep "How this distributed compute network..." → 命中
          config_versions 里 liveVersion 仍是 v11(状态对,产物不对)
```

同一现象在 AC-D 的 v15 上二次复现(门跑到一半时 `curl /` 已返回 v15 的文案)。

- **违反**:PRD CON13-②-E2「任一门红 → **线上保持旧版**」;plan T22-AC「任一门红 → failed+线上保旧版(实测:站产物未变)」;控制台失败面上写着的「线上仍是上一版,未受影响」**是一句假话**;runner 注释里的「线上保持旧版」同样不成立。
- **一个缓解事实(如实记录)**:整个发布过程中站首页 **3837 次探测 0 次非 200**,站不会挂,只会**静默换成未过门的内容**;失效的是内容正确性,不是可用性。
- **修复方向**:门必须跑在**非伺服**的构建目录上(如 `dist-staging`),`swap` 步骤才把它换成 `dist-live`(worker 改指 `dist-live`)。否则 V1-dev 下的门只是「事后告知」,不是「事前拦截」。

---

## 三、P1

### P1-1 门红之后控制台**永久 404**,失败面根本打不开
`astro build` 会清空 `dist/`(`worker/assemble-admin.mjs` 头注自己写着这条),而 `dist/admin` 只有执行器第 ③ 步 `build:console` 才重建。于是:

- 发布**进行中**:`/admin/*` 全程 404(实测 AC-C 期间 22 次探测全 404,含进度页与取消出口);
- 门红时执行器在第 ②步就 `return`,**第 ③ 步永远不会跑** → 控制台一直 404,直到有人手工 `npm run build:console`(我为了截失败面的图就是这么救回来的)。

**最需要控制台的时刻(发布中 / 刚失败)恰恰是它不可用的时刻。**

### P1-2 失败态的「查看原始日志」**永不渲染**,门的原始输出无任何 API 能取回
`GET /api/publish/status` 里 `const steps = active ? (...) : []` —— 只有**当前活跃版本**才回 steps。门红时锁已删、active=null → `steps: []` → `publish.tsx` 里 `st.steps.find(s => s.status==='failed')?.detail` 恒为 undefined → 按钮不渲染。实测失败后页面上确实**没有**「查看原始日志」。

日志本身是存了的(`publish_steps.detail`,25 行尾巴),但 `/api/publish/status` 和 `/api/config/versions` 都不返回它,**没有任何接口能把它取出来**。PRD E2/⑤/⑥ 三处都写了这个折叠面。

### P1-3 `/api/publish/next` 无租约:**两个执行器会领到同一个任务**
实测两个并发 `GET /api/publish/next` 都拿回 `v7`。`/next` 是纯读,没有 claim/lease。两个执行器会在同一棵工作树上并行跑 `verify` + `build`(互相踩 `dist/`);谁先报 `swap ok` 谁决定上线,另一个的门红回报会因为锁已被删而拿到 409 —— 而 runner 的 `api()` 是 `if (!res.ok && res.status !== 409) throw`,**409 被当成功吞掉**,红门就此消失。

### P1-4 取消不限于排队态
PRD ⑥ 写「进行中「取消」(**仅排队态**)」。实现的判据是 `COUNT(*) FROM publish_steps WHERE status <> 'running'`,所以**正在 running 的步骤不算数**。实测 materialize 处于 running 时 `POST /api/publish/cancel` 仍返回 200、锁被删。后果:执行器还在往工作树写物化文件,任务却已被判 failed,后续回报吃 409 被 runner 吞掉,runner 最后仍会打印「✓ 已上线」;工作树留下无主的物化内容。

---

## 四、P2

1. **门红只报第一道门,且原始日志与被命名的门对不齐**。runner 用 `/✗\s+([a-z0-9-]+)/i` 抓 verify 汇总里的**第一条**红门;AC-C 实测汇总是 `11/13 gates pass`(canvas-geometry **和** render-fit 两道红),失败面只说 canvas-geometry。同时 `detail` 只留最后 25 行,`[verify] ✗ canvas-geometry(运行时)` 这一行已被截掉,展开日志里满屏是 render-fit 的内容。修好第一道再发一次才会知道还有第二道。
2. **runner 把 409 当成功**(`runner.mjs` 的 `api()`),被取消 / 被抢占后仍会打印 `✓ vN 已上线`,与实际状态相反。
3. **`RULE_LABEL` 缺 `encoding-damage`**(`admin/src/pages/publish.tsx`),中文控制台上该行规则名显示英文原文 `encoding-damage`。属既定的「缺映射不隐藏」兜底,但这条是本轮新增的规则,补一行就好。
4. **「去修复」只跳页面,不定位字段**。`fixLink()` 返回的是纯路径(`/content` 等),`admin/src/pages/content.tsx` 里没有任何 `scrollIntoView` / hash / query 承接。PRD ⑥ 要求「对应内容页 → **定位到红字段**」。
5. **被并发拒绝的发布尝试也会留下 `failed` 版本行**(`有发布正在进行`),污染版本历史并跳号(本轮 v4 / v8);而审计侧没有对应行(writeAudit 在取锁之后),两张表口径不一致。
6. **回滚源可以是 `failed` 版本**。`POST /api/publish {fromVersion}` 的查询 `SELECT ... WHERE id = ?1` 无状态过滤,实测 `fromVersion=v12(failed)` 返回 200 建了 v14。UI 不给按钮,API 不拦。(仍走完整门链,故非绕门。)
7. **`publish_steps` 里被取消/中断的 `running` 行永不收尾**(`ended_at` 为 NULL),UI 的「已耗时 Ns」对这类行会算出荒唐值。
8. **终止类审计行不带理由**。`config.publish.live` / `.failed` / `.cancel` 三种动作的 `reason` 恒为 NULL,理由只挂在发起行(`config.publish` / `config.rollback`)。审计页按动作过滤时看不到理由,需人工按 target 关联两行。

---

## 五、通过项的实测证据(留档)

- **13 门映射表完整**:verify 实际输出 13 道门(`forbidden-words / i18n-parity / deploy-gate / launch-assets / state-hook-consumer / anchor-check / brand-parity / particle-hue / canvas-hazard / css-shadowed / canvas-geometry / render-fit / deck-clearance`),`GATE_REASONS` 键集与之**逐一对齐**,无缺项。实测大白话映射真出现在失败面:`画布几何在某些屏幕宽度下不成立(门:canvas-geometry)`、`文案里有合规禁用词(门:forbidden-words)`。
- **AC-B 站产物真变**:`curl http://127.0.0.1:8804/` 返回 `Distributed AI compute. Earn from your spare devices.`(旧文案 0 命中)。
- **AC-D 回滚后站产物真回退**:`curl /` 返回第一版文案,第二版文案 `ACD second version` 在产物里 **0 命中**;v16 四步齐全(gates 347.2s),v11 状态仍是 `archived`。
- **物化保真**:一次成功发布后 `git diff` 只有 `src/i18n/en.json` 一行内容差异,`vi.json` / `zh.json` / `site.json` 仅行尾符差异 —— 物化器输出与仓内文件逐字节等价。
- **前置校验分层正确**:占位符缺失是**保存级**硬拦(`PUT /api/config/draft` → 400 `placeholder`);禁用词 / 缺译 / 编码损坏是**草稿可存、发布拦**。
- **未认证防线**:`/api/publish`(GET/POST)、`/api/publish/status`、`/next`、`/step`、`/cancel`、`/api/config/draft` 无 cookie 全 401;审计 5 条变更方法全 404。

---

## 六、给实现方的最小修复清单(按优先级)

1. `/api/publish/step`:加**步骤顺序前置条件**(swap 前 materialize/gates/build 必须都 ok)+ 锁查询加 `expires_at > now`。(P0-1 / P0-2)
2. 把门跑在非伺服目录上,`swap` 才做真正的目录切换;worker 的 `assets.directory` 指向被切换的那个目录。顺带治好 P1-1(控制台不再被门内 build 清空)。(P0-3)
3. `/api/publish/status` 对「最近一次结束的版本」也回 steps(或新增 `GET /api/publish/steps?versionId=`),让失败面能展开原始日志。(P1-2)
4. `/next` 改成带租约的领取(领取即写 `claimed_by` + 心跳),或至少让 `/step` 认执行器实例 id。(P1-3)
5. `cancel` 的判据改成「**没有任何 steps 行**」(含 running)。(P1-4)
6. **补测试**:`worker/test/publish.spec.ts` 的「④ 禁止动作」加两条 —— ①正确 versionId 但跳过前序步骤报 swap ok 必须 409;②锁过期后报 swap ok 必须 409。现有那条只覆盖了冒名版本号。

---

## 七、收尾状态

- 本次验收造出的 16 个版本、审计行、发布锁全部随 `worker/.wrangler-t21` 一次性持久化目录删除而清除(该目录为本次验收自建,非仓内资产)。
- 物化写入的 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json` 已 `git checkout` 还原。
- `dist/` 已用仓内已提交内容重新 `npm run build && npm run build:console`,产物中**无任何测试文案残留**,`dist/admin` 就位。
- **`git status` = 干净(dirty 0)**;8804 / 8806 监听数均为 0;仅起过的进程树已按 PID 逐个终止。
- 冻结期内仓内写入 = **仅本报告一份**(dist 组装物与 `.wrangler-t21` 按授权除外)。
