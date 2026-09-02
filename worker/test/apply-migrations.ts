// 每个测试 worker 启动时把迁移应用到本地 D1(pool-workers 标准配方)。
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
