/* 禁用词单源(官网 PRD §1.4-1/3/4)—— 2026-08-31 自 verify.mjs 门 1 原样抽出,零语义改动。
   消费面(改这里必想全):① scripts/verify.mjs 门 1(站上机器门)② schema/src/validators.ts
   (官网后台保存/发布前置校验)。两面同 import 本文件,禁任何副本(单一真理源锁消费面)。
   历史注记原样保留:
   - "not guaranteed" 是免责声明合法用法,模式只抓「保证收益」组合。
   - 族要覆盖「保证+收益词」「百分比+周期/收益词」「定额+周期」「零/无风险」三语;
     U5 变异测试曾用 12 种常见表述探针,旧清单只命中 3 种(主人红线全靠此门)。 */

/** @type {Array<[RegExp, string]>} */
export const FORBIDDEN_PATTERNS = [
  [/guarantee[ds]?\s+(your\s+)?(returns?|income|profits?|earnings?|yields?|payouts?)/i, 'guarantee+收益词'],
  [/(risk[-\s]?free|(zero|no)[-\s]risk)/i, 'risk-free / zero-risk'],
  [/\d+(\.\d+)?\s*%\s*(monthly|weekly|daily|annual(ly)?|yearly|per\s+(month|year|week|day)|a\s+(month|year|week|day))?\s*(returns?|yields?|APY|APR|ROI|profits?|income|interest|gains?)\b/i, '百分比收益承诺'],
  /* 「百分比 + 周期」必须邻近收益名词才算承诺:本站文案天生充满抽成 % 与在线率 %
     (fee / uptime / commission 各自合法),不加这道守卫,门会变成日常绕行的对象 */
  [/\d+(\.\d+)?\s*%\s*(monthly|weekly|daily|annual(ly)?|yearly|per\s+(month|year|week|day)|a\s+(month|year|week|day))\s*(in\s+)?(returns?|yields?|profits?|income|earnings?|interest|gains?|payouts?)/i, '百分比+周期+收益词'],
  [/(APY|APR|ROI)\s+of\s+\d/i, 'APY/APR/ROI of N'],
  [/\d+(\.\d+)?\s*(USDT|USD|\$|NEX)\s+(per|every|each|a)\s+(day|week|month|year)/i, '定额周期收益'],
  [/(up\s+to|earn|make)\s+\$\d+(\.\d+)?\s*(per|every|each|a)\s+(day|week|month|year)/i, '定额周期收益($)'],
  /* 中文/越南语没有英文 "not guaranteed" 那种天然守卫,而否定式免责声明(「本站不保证收益」)
     与承诺共用同一批词 → 承诺类一律加否定前瞻 */
  [/(稳赚|保本|包赚|躺赚|看涨|(?<!不|非|无)保证(收益|回报|盈利|赚)|年化(收益)?(率)?\s*\d|收益率\s*\d|每(天|日|周|月)(收益|赚|回报|收入)\s*\d)/, '中文收益承诺/投机词'],
  [/(?<!不存在|没有|不是)(零风险|无风险)(?!是不存在|并不存在)/, '中文零风险'],
  [/(lãi\s+suất\s+đảm\s+bảo|lợi\s+nhuận\s+(đảm\s+bảo|cố\s+định)|đảm\s+bảo\s+(thu\s+nhập|lợi\s+nhuận)|không\s+rủi\s+ro)/i, '越南语收益承诺'],
  /* vi 的「% 每月」同样要邻近收益名词——手续费 5% mỗi tháng 是合法文案 */
  [/(lợi\s+nhuận|lãi)[^.。\n]{0,20}\d+(\.\d+)?\s*%\s*(mỗi|một|hàng)\s+(tháng|năm|ngày|tuần)|\d+(\.\d+)?\s*%\s*(mỗi|một|hàng)\s+(tháng|năm|ngày|tuần)[^.。\n]{0,20}(lợi\s+nhuận|lãi)/i, '越南语百分比周期收益'],
];

/** 扫描一段文本,返回命中清单(两面共用的判定函数,连判定循环都不许各写各的) */
export function scanForbidden(text) {
  const hits = [];
  for (const [re, label] of FORBIDDEN_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ label, match: m[0] });
  }
  return hits;
}
