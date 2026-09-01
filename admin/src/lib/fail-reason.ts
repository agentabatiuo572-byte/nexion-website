/* 发布失败原因 → 人话主视线 + 机器串小字。
   住在 lib 而不是某个页面:实测有**四个**消费面(壳顶红条 / 驾驶舱健康卡 /
   发布页失败横幅 / 版本历史表),第八轮走查里我先只改了发布页那两处,
   壳顶那条当场还印着 `(门:forbidden-words)` —— 修一处不等于修全部。 */

export interface FailReason {
  /** 给人看的那一句 */
  human: string;
  /** 排查用的机器串:门名,或原样的构建报错;没有则 null */
  tech: string | null;
  /** true = tech 是未经翻译的原始技术输出(该折叠/截断),false = tech 是门名 */
  raw: boolean;
}

/* 失败原因有两种,不能同一种画法(第八轮走查真跑红门时抓到):
   ① 门红——服务端已译成人话,但尾巴缀着 `(门:forbidden-words)`,机器码进了主视线;
   ② 执行器自己崩了——存进库的是原样的 Node 报错,含**本机绝对路径**
      (实录 v2:`Cannot find module 'D:\WORKS\PLAN\...\manifest.js'`)。运营读不懂,
      而且把服务器目录结构摆在了页面上。
   两种都不能删信息(排查要用),该改的是**摆在哪一层**:人话主视线,原文小字/折叠。 */
export function splitFailReason(raw: string): FailReason {
  const m = /^(.*?)(?:（|\()门[:：]\s*([a-z-]+)(?:）|\))\s*$/.exec(raw);
  if (m) return { human: m[1].trim(), tech: m[2], raw: false };
  /* 认它是原始技术输出的判据:**没有一个中文字**,或带文件系统路径。
     用「有没有中文」而不是长度阈值——服务端的人话一律是中文,而 Node/构建工具的报错一律不是。 */
  const looksTechnical = !/[一-鿿]/.test(raw) || /[A-Za-z]:\\|\/[a-z]+\/[a-z]+\//.test(raw);
  return looksTechnical ? { human: '构建或执行过程报错(非文案问题)', tech: raw, raw: true } : { human: raw, tech: null, raw: false };
}

/** 单行场合(壳顶红条 / 驾驶舱健康卡)只给人话:那两处没有排查场景,要查会点进发布页详情。 */
export const failReasonLine = (raw: string | null | undefined): string => (raw ? splitFailReason(raw).human : '原因未记录');
