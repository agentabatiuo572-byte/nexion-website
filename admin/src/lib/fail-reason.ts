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
/* 机器值:十六进制摘要、本机路径、一次性口令这类**只对排查有意义**的串。
   它们可能嵌在一句中文里 —— 那正是上一版判据看不见的形态。 */
const MACHINE_BITS = [
  /\b[0-9a-f]{8,}\b/g, // 摘要 / nonce
  /[A-Za-z]:\\[^\s,,)）]*/g, // Windows 绝对路径
  /(?:^|\s)\/(?:[\w.-]+\/){2,}[\w.-]*/g, // POSIX 绝对路径
];

export function splitFailReason(raw: string): FailReason {
  // The executor wraps command output in a Chinese gate prefix; keep the log in details.
  if (/^门未通过(?:\([^)]*\))?\s*[:：]/.test(raw)) {
    return { human: '发布检查未通过，请查看详情中的失败原因', tech: raw, raw: true };
  }
  // 截尾日志可能丢失前缀且混有中文；先隔离长篇/多行原文，避免只摘出摘要而留下整段日志。
  if (raw.length > 240 || /[\r\n]/.test(raw)) {
    return { human: '构建或检查未通过，请展开技术详情', tech: raw, raw: true };
  }
  const m = /^(.*?)(?:（|\()门[:：]\s*([a-z-]+)(?:）|\))\s*$/.exec(raw);
  if (m) return { human: m[1].trim(), tech: m[2], raw: false };
  /* 没有中文的错误也保留原文，供展开排查。 */
  if (!/[一-鿿]/.test(raw)) return { human: '构建或检查未通过，请展开技术详情', tech: raw, raw: true };
  /* 🔴 中文句子里**嵌着**机器值,是上一版判据的盲区(2026-09-01 第十轮独立验收 P1-10)。
     实录:「上线核验未通过:…(内容摘要对不上:期望 4a34ea4d0279…,实际 80e1f4a84ab0…)」
     —— 有中文,于是整句(含两串十六进制)被判成人话,原样送上壳顶常驻红条与驾驶舱主视线。
     这条判据此前只在发布页那两处被验过,壳顶与驾驶舱是**第三、第四个消费面**,没跟上。
     现在把机器值从人话里**摘出来**:主视线留完整的话,机器值收进 tech 供排查。 */
  const found: string[] = [];
  let human = raw;
  for (const re of MACHINE_BITS) {
    human = human.replace(re, (hit) => {
      found.push(hit.trim());
      return '…';
    });
  }
  // 摘干净后如果句子塌成没意义的残句,就退回原文(宁可多印,也不给一句读不通的话)
  if (found.length && /[一-鿿]{4,}/.test(human)) return { human: human.replace(/\s+/g, ' ').trim(), tech: found.join(' · '), raw: false };
  return { human: raw, tech: null, raw: false };
}

/** 单行场合(壳顶红条 / 驾驶舱健康卡)只给人话:那两处没有排查场景,要查会点进发布页详情。 */
export const failReasonLine = (raw: string | null | undefined): string => (raw ? splitFailReason(raw).human : '原因未记录');
