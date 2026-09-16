# 网站默认文案补齐与 AI 翻译实施方案

状态：设计方案；不代表功能已实现、密钥已配置或翻译已执行。日期：2026-09-09。

## 1. 目标、事实与范围

目标：后台支持语言有可用的默认文案；保存原文后自动准备其他语言；人工修改不被覆盖；译文保存进草稿，经现有发布流程生效。

日常操作收敛为：首次补齐默认文案 → 配好 API Key 并启用翻译 → 保存英文 → 后台自动补译 → 查看结果并按原流程发布。无需操作发布器或维持浏览器页面打开。

已核实基础：

- 支持语言由 `schema/src/locales.ts` 定义，共 9 种；英语是当前源语言、默认路由和显示回退语言。
- 前序实库只读快照为草稿 rev10、九语开启。es/pt/fr/de/ja/ko 各缺 220 条普通文案、20 条 FAQ 问答、7 条产品标语，共 1,482 条必填译文；这些源文全部与当前种子对应内容一致，目标译文存在。实施前重新计算，不能把这个数字当固定断言。
- 当前 manifest 和 seed 均有 223 个普通文案键；另 3 项白皮书文案已填写。新增语种的空白来自旧配置兼容逻辑，不是仓库没有默认译文。
- `useT()` 的 `??` 只处理不存在的值，不处理空字符串；`useDraft()` 当前提交整份 payload，不能直接叠加持续异步写入。
- Worker 尚无 AI 凭据和通用翻译任务机制。现有发布器、发布锁和机器凭据不承担翻译写稿。

调用方案：支持 OpenAI、Anthropic Claude、Google Gemini、DeepSeek、Groq、OpenRouter、OpenCode Zen 官方 API，固定英语为源语言。服务商、默认模型和允许模型以服务端 `AI_PROVIDERS` 为单一来源。目标覆盖其余全部支持语言，包括暂未公开的语言。使用原生 fetch、WebCrypto、现有 Zod/D1，不新增 AI SDK、队列产品、第二发布器或独立常驻服务。源语言切换、OAuth、多供应商自动切换不在实现范围。

| 内容 | 首版处理 |
| --- | --- |
| manifest 普通文案、未删除 FAQ 问答、全部产品标语 | 自动补默认；无匹配默认时进入 AI 翻译 |
| 公告 | 英文非空时可准备译文；启用时全部公开语种必须完整 |
| SEO title/description 覆盖字段 | 英文覆盖非空时翻译；英文为空表示沿用默认，保持空覆盖语义 |
| 法律 Markdown | 保留既有英文/内置正文回退，首版不自动改写法律正文 |
| Learn Markdown、PDF、URL、ID、价格、统计值、排序及显隐 | 不由 AI 字段补译修改；文章及 PDF 继续原文件流程 |

后台“参考语言”仍是只读对照，不隐式改变翻译源。支持语言已准备文案不等于自动公开该语言。

## 2. 页面与操作

新增 `/admin/ai`“AI 翻译设置”，导航放在语言设置旁；沿用后台样式和现有管理员会话。

| 区域 | 内容与动作 |
| --- | --- |
| 连接 | 服务商与对应模型下拉框；API Key 密码框；“测试并保存”；“测试当前连接”；“移除配置”。切换服务商清空候选 Key；当前已保存的服务商与模型独立显示 |
| 状态 | 未配置、可用、密钥无效、模型不可用、额度不足、暂时限流、服务端加密配置缺失；最近测试时间 |
| 自动补译缺项 | 默认关闭；连接可用后可启用。关闭只暂停后台自动任务；逐项按钮和连接测试可独立执行；默认译文补齐不依赖 AI 开关或密钥 |
| 任务 | 待处理、处理中、已完成、失败、已过期/取消数量；失败详情和重试；不展示密钥或完整请求日志 |
| 用量 | 今日发送字符、调用次数、已知返回 token；金额如展示须标“估算”，不展示虚构账户余额 |

模型从部署时的允许列表选择，至少一个模型须完成真实结构化翻译测试后才能进入可用列表；不自动追随“最新模型”。API Key 提交后清空输入框，读取接口仅返回已配置、凭据修订和状态，不回传完整密钥。

语言设置增加“补齐默认文案”和“一键补译缺项”。前者先展示可确定补齐数量，点击后仅写草稿；后者将不能复用默认的缺项入队。存量首次补齐显式触发，GET/打开页面不改数据。之后保存原文、创建 FAQ、启用语言时自动扫描相关缺项。

各编辑页复用 `LocaleToolbar/LocalePair`：语言及缺译状态旁放一个“AI 翻译”按钮，已有默认译文直接显示在目标输入框。点击按当前英语生成建议，回填当前输入框，可继续人工修改，经本页原有保存动作写草稿。无需先保存或二次确认；失败保留输入。请求期间修改英语、目标输入或切换语言使本次回填失效，不覆盖新编辑。英语不能冒充目标译文，主动清空不能被默认值静默复填。批量操作、任务及用量收于高级设置。

连接、AI 开关和用量上限属于即时生效的后台运营配置，不要求发布网站；译文始终属于草稿。停止 AI 不清空已有译文。移除配置先说明将暂停新任务；此操作不是撤销服务商账户里的 Key。

## 3. 文案与保存契约

### 3.1 一个字段清单

在 schema 中提取共用的可翻译字段枚举，供默认补齐、缺译进度、任务生成和结果验证使用。每项包含稳定 fieldId、源文、目标值、上下文、格式、必填规则和长度约束。AI 只能返回服务端已分配 ID 的译文，不能指定写入路径。

- 普通文案按现行 manifest key；禁止整份 seed 对象覆盖或恢复已退休键。
- FAQ 按永久 ID，源文摘要包含问题和回答，不能按 q1/q2、数组位置或排序匹配。
- 产品标语按 SKU ID，摘要包含英文标语和产品身份；公告/SEO 使用固定字段身份。
- sourceHash 只包含字段身份、源文及必要上下文；模型/规则版本另存执行指纹，不参与已落地译文的新鲜度判断。仅目标为空、没有人工维护标记且默认源文/上下文逐字一致时复用种子，禁止模糊匹配。人工主动清空也受保护，只有明确的单字段补译/重译操作才可接管。
- 默认译文和 AI 结果共用结构、占位符、链接及长度校验。只有英文与种子逐字一致、候选也正是对应已审核种子值时，保留既有本地数字与断行形式；新 AI 候选额外校验数字、实体和必要换行。无可用源文时返回 source-empty，等待补原文，不反复调用 AI。

### 3.2 共享草稿写入服务

抽取当前保存的结构校验、公告 ID 更新、Legal 清洗、revision CAS 和审计为同一服务；默认补齐、人工保存、AI 应用均调用。法律不自动翻译，不等于人工保存可绕过原清洗。

为 `config_draft` 增加 `write_nonce`。更新 payload 时同时条件更新 revision 和随机 nonce；同事务内的来源、任务及审计变更必须以这个 nonce 与新 revision 为归属守卫。不能让失败的 CAS 方借到其他请求的修订号，也不依赖长链 changes() 的隐式状态。

一次确定性默认补齐在内存生成完整补丁，一次事务写草稿、来源和审计；没有有效修改时不升 revision。批量来源/任务使用有界参数化批量写，不为 1,482 个字段逐个更新草稿。重复点击不覆盖非空值、不重复升修订。

### 3.3 人工编辑与 AI 并发

保留现有 PUT 接口的严格 revision 拒绝行为；新增 PATCH 接口供更新后的编辑器使用。补丁包含 fieldId、编辑开始时的 before 值和实际 after 值；服务端从最新草稿应用，仅在 current==before 或 current==after 时通过。不能用最新 revision 重发旧整稿。

PATCH 的 baseRevision 可以落后，最终提交仍对最新草稿做 CAS；重复字段、未知键、非法语言或不存在的条目直接拒绝，任一真实冲突导致整批人工补丁不落稿。过渡期间尚用 PUT 的页面必须冻结开始编辑时的 revision；全部编辑入口完成保护前，不启用异步 AI 写稿。

`useDraft` 必须捕获“开始编辑时”的基线，不能从轮询后的最新 overview 反推修改意图。页面只提交真正被人工改变的字段；未修改的其他语种不随旧工作副本写回。提交过程中后续输入继续保留，复用 `retainPostSubmit`。

普通字段按稳定路径合并；FAQ/SKU 按 ID 而非数组下标。新增、删除、排序作为明确结构操作校验，不能从整条旧对象覆盖新的译文。同一字段有真实冲突时返回路径和最新值，保留本页输入，不强制刷新清空。人工写入目标字段时记录 manual 并更新 generation；删除条目使其任务过期。

current==after 只有在值和来源状态都满足请求时才是 no-op。人工提交恰与刚落稿的 AI 文字相同，仍须转为 manual、递增 generation 并取消旧待办；重复提交才不再升修订。“保留现译”是显式确认当前源文的动作，不能依赖先改字再改回制造提交。

AI 应用前重读当前草稿，逐项检查 generation、源文摘要、目标预期值、字段是否存在及人工归属；仅合并仍成立的项。CAS 冲突可重读并重试应用已取得的结果，不再次调用模型。已有非空但没有来源记录的值一律按人工维护保护。

以上重读只是筛选；最终草稿 CAS 的 SQL 条件还必须同时检查 job 的 running 状态、leaseToken、generation、有效连接修订和开关，来源/任务完成状态受同一 write_nonce 守卫。取消、租约转移或换 Key 与写回由数据库仲裁；不能仅在请求开始时校验，也不能让旧执行器改写新执行器状态。

原文变化只自动刷新本系统管理、且目标值仍与上次机器结果相同的译文。人工维护内容保留并标“原文已更新”；首版只提供明确的单字段重新翻译操作，不进行全站强制覆盖。

逐项按钮只返回建议，不建任务、不写草稿；输入框保存采用原有人工字段补丁及并发基线保护，落稿后保留 manual 归属。已有单字段排队任务仍按 generation/基线检查处理。删除条目的来源代次保留为墓碑，重新出现同 ID 不能复活旧任务。

## 4. 凭据、接口与调用

### 4.1 凭据配置

一个始终存在的 `ai_connection` 运营配置记录：provider、model、credential_rev、settings_rev、enabled、key_ciphertext/iv/key_version、operation_seq/operation_id/operation_status、最近测试状态、全站调用 leaseToken/leaseUntil，以及当天额度预留计数。密钥使用独立根密钥与 AES-GCM 加密，随机 IV，认证附加数据绑定连接身份、服务商和密文格式版本，保留旧 Zen 密文兼容性。移除配置只清密文、停开关并递增修订，不能删除运营行或重置当天额度；更换 Key 同样不重置额度和代次。

根密钥 `AI_CREDENTIAL_ENCRYPTION_KEY` 只在 Worker Secret/本机专用受保护配置中；不能复用后台密码、发布机器密钥或其他业务 Secret。缺根密钥、解密失败均拒绝解密、测试与保存，不生成临时根密钥、不回退明文；已认证管理员仍可显式清除密文、递增代次并留下审计，之后人工配置新根再重配连接。本机与生产凭据隔离。

“测试并保存”采用单次有界请求：候选 provider + Key + model + expectedCredentialRev + expectedOperationSeq + operationId → 检查服务商与模型配对、加密就绪、修订与限额并原子预占全站租约/操作序号 → 对固定短句做真实模型调用和结构校验 → 加密 → CAS 更新凭据字段并审计。测试成功原子更新服务商、Key、模型、凭据修订和测试结果，保留最新 AI 开关、settingsRev 和额度。测试失败保留旧配置；迟到的 A 请求不能覆盖后来保存的 B。无需候选凭据表或独立激活流程。

操作占位不含 Key；operation_seq 单调递增。重复当前 operationId 返回处理中/既有结果；已被后续操作取代的旧序号在出网前拒绝，不能仅凭“上次成功 ID”去重。进程失联时将已发出测试标 unknown，不自动重新付费。

网络断开不代表保存失败：页面回读 activeRevision/operationId/operationStatus 再判断，不盲目重复付费测试。测试请求先提示会有少量 API 用量；候选测试结果与当前连接就绪状态分别返回，候选失败和旧请求的错误不能把正在使用的 Key 标为无效。审计只记操作、模型、修订和结果码，不记 Key、Authorization 或原始供应商错误正文。

### 4.2 接口草案

| 接口 | 作用与限制 |
| --- | --- |
| `GET /api/ai/connection` | 返回脱敏配置、就绪状态和连接修订 |
| `PUT /api/ai/connection` | 测试候选并条件保存；管理员会话、同源校验、凭据修订/操作序号/operationId |
| `POST /api/ai/connection/test` | 测试当前连接；有频率和调用上限 |
| `DELETE /api/ai/connection` | 按凭据修订移除配置，暂停新调用及重试 |
| `PATCH /api/ai/settings` | AI 开关及允许范围内的每日上限；settingsRev 条件更新 |
| `POST /api/translations/defaults` | 重算并应用可确定的默认译文；返回 applied/skipped/revision |
| `POST /api/translations` | 对允许范围生成补译/单字段重新翻译任务；不接受任意 prompt、URL 或 JSON 路径 |
| `POST /api/ai/translate` | 当前英语 source、targetLocale → 同步返回 text 建议；共用安全连接、租约、限额和结果校验，不写草稿 |
| `GET /api/translations` | 状态、进度、错误码；分页；不返回凭据 |
| `POST /api/translations/retry` | 对选定失败项重新核验源文、归属、连接和限额后重试 |
| `POST /api/translations/cancel` | 取消未应用任务，保留已完成译文；迟到结果不应用 |
| `PATCH /api/config/draft` | 带 before/after 的人工字段补丁；共享校验、合并和审计 |
| `POST /api/internal/translations/tick` | 本机调度专用；仅消费已授权待办，不能提供任意文案或创建任务 |

除 tick 外全部使用现有管理员会话。变更接口执行同源、内容类型、结构、长度和频率检查；tick 使用独立 `AI_TICK_TOKEN`，权限不授予配置读取、创建翻译或直接写稿。

供应商错误映射为 AI 业务错误：401/403 密钥或权限问题暂停对应凭据版本的任务；429 区分额度不足和临时限流；网络/5xx 有限重试。**不能将供应商 401 原样返回给 Admin**，否则现有 api.ts 会跳回后台登录。HTTP 401 只表示后台会话失效。

### 4.3 模型调用边界

只调用所选服务商固定的官方 HTTPS endpoint，禁止自定义代理地址、重定向携带密钥、模型提供工具调用或决定字段路径。原文作为待翻译数据，指令要求保留含义、品牌实体、数字、占位符、URL 和必要 Markdown/换行结构，不新增产品事实。

OpenAI / Zen 复用 Responses，Gemini / Groq / OpenRouter / DeepSeek 复用 Chat Completions，Claude 使用 Messages；各协议只接收完整的非流式文本结果，拒绝工具调用、拒答和截断。支持时使用严格 JSON Schema；DeepSeek 使用官方 JSON Object 模式并给出明确结构示例，所有服务商都经过相同的本地字段与文案校验。`store:false` 不表述为服务商零保留。接口可用性及结构化输出支持以实际 Key 请求为准。

结果必须是精确字段 ID 集合的结构化 JSON，字符串非空且在上限内。除现有全配置校验外，为所有翻译字段新增占位符多重集、受保护文本/数字/链接与结构检查；现有 copy 占位符检查不能代替这个边界。拒绝、多余/缺失字段、截断及语言明显错误均不写草稿。结构通过不等于母语质量已审校。

## 5. 任务、来源与限额

除连接记录外使用两张表，不新增通用任务平台：

| 表 | 必要信息 |
| --- | --- |
| `translation_state` | fieldId + targetLocale 唯一；origin(seed/ai/manual)、sourceHash、appliedValueHash、generation、更新时间 |
| `translation_jobs` | 每字段目标语每 generation 一项；任务 ID、来源意图、源文/上下文快照及摘要、目标预期值、generation、凭据修订、模型/规则版本、状态、leaseToken/leaseUntil、attempts/nextAttemptAt、结构化结果、错误码、调用用量与时间 |

同一生成代次唯一约束去重；模型请求可以按目标语言合批，不另建 batch 表。管理员保存原文、更新来源代次及创建必要待办在同一草稿事务中完成，避免“保存成功但没有任务”。人工/默认/AI 更新的来源由服务端判定，不信任客户端自报。

state.sourceHash 表示当前已落地译文所对应的源文摘要；源改只增加 generation、建立待办，不能提前把旧译文的 sourceHash 改成新值。人工确认现译时才更新其已确认源文摘要。AI 关闭时仍记录过期状态，重新开启时扫描缺项及可自动维护的过期项。

状态：pending → running → succeeded；不满足应用条件转 obsolete，管理员取消转 cancelled；临时失败退回 pending 并设下次时间，达到上限转 failed。租约过期可恢复。已得到的结果先持久保存；恢复时优先验证并应用该结果，不能把“未回写”当成必须再次请求 AI。

默认工程上限（新设计值，需在首个真实模型测试中验证）：

| 参数 | 首版值及规则 |
| --- | --- |
| 合批 | 同一目标语，每批最多 20 字段、原文加上下文合计 3,000 字符；首版不分片，单字段超限标 too-long 并保留原稿，改用人工译文 |
| 并发 | 每个站点同时一个模型请求；翻译、连接测试、保存加速共用 ai_connection 的全站租约，不能只锁各自任务 |
| 超时 | 模型请求 20 秒；每次 tick 工作预算 25 秒；本机 HTTP 30 秒；租约 90 秒 |
| 重试 | 总尝试最多 3 次；临时失败退避 30/120 秒，并尊重更长的 Retry-After |
| 每日上限 | 默认 50,000 发送字符，后台可设 1,000–500,000；按 UTC 日、每个目标语言与每次外部尝试分别累计；单次 max_output_tokens 为 4,096，响应体最多 256 KiB |

调用前事务预留字符与请求次数；一旦外部请求发出，即使超时也不退款为“零消耗”。仅未发出的预留可释放。连接测试也受独立低频限制并计调用量。供应商返回 token 数按实际记录，超时缺数据记 unknown；这里的字符限额不是服务商账单或精确金额预算。

全站租约、领取任务和额度预留由同一事务守卫；每次实际 HTTP 调用只计一次请求、按本批实际文本预留字符，不能按字段行重复统计返回 token。进程失联后的预留保守保留；只能证明未发出时释放。重复 tick 保证不会重复应用，不能承诺模型请求恰好一次或网络超时没有收费。超过长字段上限和输出限制的内容明确报错，不进入无限重试；提高上限或增加分片须有实际样本和验证。

关闭 AI/移除凭据后不再领取或重试，未应用结果不得继续写稿；已发出请求无法承诺撤回。关闭/切换配置使旧执行令牌失效，保留在途租约至请求结束或到期，防止立即启动第二个请求。重新开启/更换可用连接后，仍适用的待办绑定新配置和新执行令牌，旧响应不能落稿或更新新连接状态。尝试计数不因切 Key 清零；人工重试重新核对并创建新 generation，所有尝试继续计入当日额度。仅凭据改变无需改已落地译文；模型/规则版本改变也不强制全站重新付费翻译。

具体恢复：pending 保留源/目标快照；running 作废旧领取令牌后回待处理；旧配置已持久但未应用的候选标为不可采用，不重新贴成新模型结果。恢复前重新核对原字段授权和基线；自动任务仍适用才重新绑定当前配置，manual 单次重译保留原稿并显示“需重试”，由明确重试动作重新确认。单纯调整额度不使有效领取令牌和译文失效。

## 6. 调度与发布隔离

生产：复用 Worker 每分钟定时入口，分别运行发布维护与翻译维护，独立处理错误；AI 失败不跳过发布维护。保存后的 waitUntil 可启动一小批作加速，D1 待办负责持久性，不能靠一个请求后台完成整站翻译。

本机：Wrangler 定时任务不会被当作“已经自动运行”。将现有 API supervisor 的阻塞等待调整为对子进程的监督循环，每 60 秒向已验证归属的 loopback Worker 发受限 tick。仍是原 API supervisor 和原 Worker 子进程，不新增常驻服务；tick 失败只记状态，不擅自重启健康 Worker。保留原停止、进程归属和退出行为；当前 API 子进程退出后 supervisor 也退出，首版不新增自动拉起，重启现有启动器后恢复持久待办。

HTTP tick 仅本机 dev 开启，空请求体；生产不开放该入口，scheduled 直接调用相同消费函数。本机 tick 同步 await 一批后返回摘要，专用 HTTP 超时为 30 秒，不沿用现有 15 秒。禁止代理/重定向，发送 token 前核实服务归属。生产发布维护与翻译维护用独立结果处理，不能由其中一项抛错跳过另一项。

`AI_TICK_TOKEN` 与根密钥本机由启动准备一次性生成/保存，已有值不覆盖；只注入 API 进程。AI Key 不进入进程命令行。云端通过部署 Secret 配置；后台无需取得 Cloudflare 管理 Token。

一次性生成仅适用于明确未初始化的状态；已有密文或初始化标记但根密钥丢失时禁止生成替代根。保留密文/任务，恢复原根或显式移除连接后重配。沿用受保护目录、DPAPI/私有 ACL、Git 忽略与未跟踪、非链接检查；AI 配置异常只暂停 AI，不阻断官网和现有发布服务启动。

凭据、根密钥、tick token、连接测试数据及任务内部数据不得进入 SiteConfig、config_versions、种子、导出、公开资产、发布证据或构建子进程环境。同时更新 `scripts/launcher-publish.ps1` 的 runner 环境清理和 `worker/lib/runner-core.mjs` 的构建子进程过滤；验证 `.local-start`、`.dev.vars`、`.wrangler` 不被带入发布工作区，不能只凭 D1 单独建表就声称完成隔离。

发布只读取被冻结的草稿版本。AI 若在确认前更新草稿，现有 revision 检查要求重新核对；若在建单后更新草稿，只形成下一次待发布改动，不能修改在途快照。新增只读新鲜度检查，复用于草稿 validate、发布 preflight 和实际建单：启用语言的必填字段缺译或机器译文过期即阻断；不能因为旧译文非空就放行。已有有效译文的可选重译任务、人工译文源改提醒、未启用语言待办不阻断。

检查以同一草稿 revision 为依据；影响可发布性的来源状态变化也必须进入草稿 CAS 并升 revision，建单时再核修订。历史回滚只校验选定的固定历史内容，不用当前草稿的任务/来源状态拦截，既有版本正文不变。不要在 build/verify/materialize 中调用模型。

## 7. 实施步骤与文件责任

开始实施时基于当前工作树和外部 PRD重新记录快照（当前 HEAD 为 a171bba61bdb4658f979acdfcf088a14cd81f6e8，存在大量既有 WIP）；只对本功能增量验收。初始化独立 task-workflow 实施计划，最后单设 integration。以下为开发顺序，不代表已执行。

| 步骤 | 交付与依赖 | 主要文件 |
| --- | --- | --- |
| S1 默认补齐 | 字段枚举、共用写稿服务/事务归属、确定性默认补齐、普通文案空值显示回退；不依赖 AI Key | schema 新字段模块、worker/src/config.ts/新写稿服务、迁移、src/i18n/index.ts、语言设置/共享编辑器 |
| S2 保存合并 | 依赖 S1；PATCH 契约、编辑开始基线、全部编辑页人工意图合并、来源/generation保护 | admin/src/lib/use-draft.ts、async-state.ts、各内容编辑页、worker 配置路由 |
| S3 AI 连接 | 可与 S2 独立开发；加密、单请求测试并保存、Key错误/限额/状态、设置页 | worker 新 ai-connection/ai-client 模块、env.ts/index.ts/audit.ts、D1迁移、admin 新 ai.tsx/main.tsx/shell.tsx |
| S4 自动处理 | 依赖 S1/S2/S3；持久任务、结果保护、重启恢复、云端/本机 tick、凭据隔离 | worker 新 translation 任务模块、index.ts、start-website.ps1及已有启动器模块、runner-core及隔离测试 |
| S5 集成验收 | 依赖前述全部；真实 Key小样、并发与故障、九语构建与真实本机发布、独立审查 | Worker/Admin测试、publisher/launcher回归、独立隔离验收脚本、文档与PRD |

接口和迁移由主线统一合入，避免并行修改同一迁移/index入口。新文件命名在实施时按现有模块组织确定；不为“将来多服务商”创建工厂或插件框架。

PRD同步范围：CON04 删除旧“永不自动机器翻译”禁令并替换为本文的保存/保护契约；同步 CON02 导航与提示、CON08 FAQ、CON10 SEO、CON13 发布前状态、CON14 审计、CON16 凭据与发布隔离；新增 AI 连接/翻译任务功能契约。法律英文回退规则保留，不借本功能改整份历史PRD。

## 8. 验收与发布顺序

| 验收 | 必须获得的证据 |
| --- | --- |
| A1 默认补齐 | 重新统计当前缺口；源文匹配项无 AI 调用完成；非空人工值、退休键及历史版本不变；刷新后持久、重复点击幂等 |
| A2 保存并发 | 两个页面编辑不同字段、AI写另一语种、排序FAQ三者交错不互相覆盖；同字段冲突明确且输入保留；人工同值接管后不再自动覆盖；过渡PUT不拿新revision盖旧稿 |
| A3 迟到结果 | 执行期间改原文、改目标、删除条目、A→B→A变更、取消或更换Key，旧结果不覆盖、不复活条目 |
| A4 凭据 | 错Key不踢后台登录；旧测试不覆盖新配置或恢复关闭开关；同操作并发/重放不重复收费；断网后回读辨认保存结果；根密钥缺失/解密失败不偷偷换根且不阻断网站；测试失败旧连接仍可用 |
| A5 调用质量 | 少字段、多字段、截断、拒绝、错误语言、占位符/链接/数字损坏不落草稿；合法译文保留格式并通过配置门 |
| A6 恢复与费用 | 重复建单、租约超时、进程重启、额度边界与429；翻译/连接测试并发仍只出一个请求；切换/移除Key不重置限额；已持久结果直接应用；未知消耗不冒认0 |
| A7 调度隔离 | Worker存活时关闭浏览器仍处理已授权待办；重启启动器后恢复持久任务；翻译失败时发布维护仍执行，发布忙时翻译调度仍有独立触发 |
| A8 发布实物 | 当前九语必填译文完整，Legal/SEO/Learn按表定回退验证；所有构建门、实际页面/语言切换/占位符与换行检查；过期机器译文阻断新发布但不影响在途任务或历史回滚；后台真实发布并刷新；源码/配置/实物摘要一致 |
| A9 无秘密泄漏 | API返回、LocalStorage、审计、日志、导出、发布私有工作区、构建子进程环境与最终dist均无Key/根密钥/tick token |

使用现有 `npm --prefix worker test`、`npm --prefix worker run typecheck`、`npm --prefix admin run build`（已含 Admin 类型与测试）、`npm --prefix worker run test:publisher`、`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/test-start-website.ps1`、`npm run typecheck`、`npm run verify`（回读 `.verify-exit.code`）；新用例接入这些既有门。各步骤先跑相应检查，集成再跑全部，避免每改一行重复整站构建。

浏览器验收使用已核实与本工作树产物一致的构建服务；Admin覆盖全部相关入口、桌面和窄屏、刷新持久及console错误。九语脚本入口为 `node --import ./worker/register-ts-ext.mjs scripts/locale-acceptance.mjs`；当前只消费 buildSeed，必须增加实际冻结草稿输入及 SHA 校验，再用同一草稿做隔离构建与发布验收。种子九语通过、旧三语实测都不能冒充实际 AI 译文通过。

按默认补齐 → 小批真实 AI → 人工与AI交错 → 故障恢复 → 全量本机发布逐步扩大。真实 API Key由后台录入，主密钥和可用模型首次部署准备；在缺真实调用时只能标“模拟测试通过”，不得宣称AI接入完成。公网部署、GitHub推送和提交另按授权执行。

## 参考依据

- [OpenCode Zen官方接口与模型](https://opencode.ai/docs/zen/)
- [Google Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [Groq 结构化输出](https://console.groq.com/docs/structured-outputs)
- [Claude 结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode)
- [OpenRouter 结构化输出](https://openrouter.ai/docs/features/structured-outputs)
- [OpenAI API 鉴权与服务端凭据](https://developers.openai.com/api/reference/overview)
- [OpenAI 结构化输出及其内容错误边界](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Cloudflare Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare HTTP后台执行时限](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Cloudflare动态写Secret需要管理权限](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)
- 现有规格：`D:/WORKS/PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`；实现依据为本仓 schema、config、auth、publish 和共享编辑器当前工作树。
