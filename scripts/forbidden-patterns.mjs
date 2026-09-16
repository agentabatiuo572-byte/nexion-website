/* 禁用词单源(官网 PRD §1.4-1/3/4)—— 2026-08-31 自 verify.mjs 门 1 原样抽出,零语义改动。
   消费面(改这里必想全):① scripts/verify.mjs 门 1(站上机器门)② schema/src/validators.ts
   (官网后台保存/发布前置校验)。两面同 import 本文件,禁任何副本(单一真理源锁消费面)。
   历史注记原样保留:
   - "not guaranteed" 是免责声明合法用法,模式只抓「保证收益」组合。
   - 族要覆盖「保证+收益词」「百分比+周期/收益词」「定额+周期」「零/无风险」三语;
     U5 变异测试曾用 12 种常见表述探针,旧清单只命中 3 种(主人红线全靠此门)。 */

/** @type {Array<[RegExp, string]>} */
export const FORBIDDEN_PATTERNS = [
  /* 六种新增语言只是同一合同的等价表达：保证收益、无风险、百分比收益、定额周期收益。
     费率/在线率/佣金占比没有收益名词时不命中，行业数字也不属于收益数字。 */
  [/(?<!no\s)(?:garantiza(?:mos|n|r)?|garantizamos)\s+(?:los?\s+)?(?:rendimientos?|ingresos|ganancias|beneficios)|(?:rendimientos?|ingresos|ganancias|beneficios)\s+garantizad[oa]s?|(?<!no\s)(?:sin|cero)\s+riesgo/i, '西班牙语保证收益/无风险'],
  [/(?:rendimientos?|rentabilidad|inter[eé]s|ganancias)\s+(?:mensual(?:es)?\s+|anual(?:es)?\s+)?(?:de(?:l)?\s+)?\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s+(?:(?:mensual|anual|diario|semanal)\s+)?(?:de\s+)?(?:rendimientos?|rentabilidad|inter[eé]s|ganancias)/i, '西班牙语百分比收益'],
  [/\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|\$)\s+(?:(?:al|por|cada)\s+(?:d[ií]a|semana|mes|año)|diarios?|mensuales?)|\$\s*\d+(?:[.,]\d+)?\s+(?:(?:al|por|cada)\s+(?:d[ií]a|semana|mes|año)|diarios?)/i, '西班牙语定额周期收益'],
  [/(?<!não\s)(?:garantimos|garant[ei]r?|garantem)\s+(?:os?\s+)?(?:rendimentos?|renda|lucros?|ganhos|retornos?)|(?:rendimentos?|renda|lucros?|ganhos|retornos?)\s+garantid[oa]s?|(?<!não\s)(?:sem\s+risco|risco\s+zero)/i, '葡萄牙语保证收益/无风险'],
  [/(?:rendimentos?|rentabilidade|juros|lucros?|retornos?)\s+(?:(?:mensal|anual)\s+)?(?:de\s+)?\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s+(?:(?:mensal|anual|di[aá]rio|semanal)\s+)?(?:de\s+)?(?:rendimentos?|rentabilidade|juros|lucros?|retornos?)/i, '葡萄牙语百分比收益'],
  [/\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|\$)\s+(?:(?:por|a\s+cada)\s+(?:dia|semana|m[eê]s|ano)|di[aá]rios?|mensais)|\$\s*\d+(?:[.,]\d+)?\s+(?:por\s+(?:dia|semana|m[eê]s|ano)|di[aá]rios?)/i, '葡萄牙语定额周期收益'],
  [/(?<!ne\s)(?:garantit|garantissons|garantir)\s+(?:des?\s+|les?\s+)?(?:rendements?|revenus|profits?|gains)|(?:rendements?|revenus|profits?|gains)\s+garantis?|(?<!pas\s)(?:sans\s+risque|z[eé]ro\s+risque)/i, '法语保证收益/无风险'],
  [/(?:rendements?|rentabilit[eé]|int[eé]r[eê]ts?|profits?|gains)\s+(?:(?:mensuels?|annuels?)\s+)?(?:de\s+)?\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s+(?:(?:mensuels?|annuels?|quotidiens?|hebdomadaires?)\s+)?(?:de\s+)?(?:rendements?|rentabilit[eé]|int[eé]r[eê]ts?|profits?|gains)/i, '法语百分比收益'],
  [/\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|\$)\s+(?:par|chaque)\s+(?:jour|semaine|mois|an|ann[eé]e)|\$\s*\d+(?:[.,]\d+)?\s+(?:par|chaque)\s+(?:jour|semaine|mois|an|ann[eé]e)/i, '法语定额周期收益'],
  [/(?<!nicht\s)(?:garantierte[nmrs]?\s+(?:Rendite[n]?|Einkommen|Gewinne|Ertr[aä]ge)|garantier(?:t|en)\s+(?:die\s+)?(?:Rendite[n]?|Einkommen|Gewinne|Ertr[aä]ge)|risikofrei)|(?:Rendite[n]?|Einkommen|Gewinne|Ertr[aä]ge)\s+garantiert|(?<!kein\s)(?:ohne\s+Risiko|Nullrisiko)/i, '德语保证收益/无风险'],
  [/(?:Rendite|Zinsen|Gewinn|Ertrag)\s+(?:(?:monatlich|j[aä]hrlich)\s+)?(?:von\s+)?\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s+(?:(?:monatliche|j[aä]hrliche|t[aä]gliche|w[oö]chentliche)\s+)?(?:Rendite|Zinsen|Gewinn|Ertrag)/i, '德语百分比收益'],
  [/\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|\$)\s+(?:pro|je|jeden)\s+(?:Tag|Woche|Monat|Jahr)|(?:t[aä]glich|monatlich|j[aä]hrlich|w[oö]chentlich)\s+\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|\$)/i, '德语定额周期收益'],
  [/(?:利益|収益|収入|利回り)(?:を|が|は)?保証(?!しない|しません|されません|されない|はない|はありません|できません)|保証された(?:利益|収益|収入|利回り)|(?:リスクゼロ|無リスク|ノーリスク)(?!ではない|ではありません|はない|はありません)/, '日语保证收益/无风险'],
  [/(?:年利|月利|日利|利回り|利益率|収益率)\s*(?:は|が|の)?\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s*(?:の)?(?:利回り|利益|収益|利息)/, '日语百分比收益'],
  [/(?:毎日|毎週|毎月|毎年|1日あたり|1か月あたり)\s*(?:(?:利益|収益|収入|報酬)(?:が|は)?\s*)?\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|ドル)|\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|ドル)\s*(?:毎日|毎週|毎月|毎年)/i, '日语定额周期收益'],
  [/(?:수익|수입|이익|수익률)(?:을|를|이|가)?\s*보장(?!하지|되지|은\s*없)|보장(?:된|되는)\s*(?:수익|수입|이익|수익률)|(?:무위험|위험\s*제로|리스크\s*제로)(?!이\s*아닙니다|이\s*아니다)/, '韩语保证收益/无风险'],
  [/(?:(?:연|월|일)\s*)?(?:수익률|이자율|수익|이익)\s*(?:은|는|이|가)?\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s*(?:의\s*)?(?:수익|이익|이자)/, '韩语百分比收益'],
  [/(?:매일|매주|매월|매년|하루에|한\s*달에)\s*(?:(?:수익|수입|보상)(?:이|은)?\s*)?\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|달러)|\d+(?:[.,]\d+)?\s*(?:USDT|USD|NEX|달러)\s*(?:매일|매주|매월|매년)/i, '韩语定额周期收益'],
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
  const normalized = text.normalize('NFKC'); // 全角数字/百分号与半角表达同一合同，不能成为旁路。
  for (const [re, label] of FORBIDDEN_PATTERNS) {
    const m = normalized.match(re);
    if (m) hits.push({ label, match: m[0] });
  }
  return hits;
}
