/* [FEAT-WEB11] Learn content collection — 文章即文件(v1 无 CMS)。
   路径:src/content/learn/{locale}/{slug}.md;三语同 slug;缺译回退 en(WEB01 异常2)。 */
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const learn = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/learn' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    topic: z.enum(['start', 'earn', 'devices', 'wallet', 'team', 'nex']),
    appVersion: z.string(),
    updatedAt: z.string(),
    order: z.number(),
    prdRef: z.string(), // App PRD 章节锚(内容偏差以 App PRD 为准)
  }),
});

export const collections = { learn };
