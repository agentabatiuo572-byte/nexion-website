import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scanForbidden } from './forbidden-patterns.mjs';
import { LOCALES } from '../schema/src/locales.ts';

// Each language exercises the existing four forbidden families, in both word orders where applicable.
const red = {
  es: ['rendimientos garantizados', 'garantizamos ingresos', 'sin riesgo', 'cero riesgo', 'rentabilidad de 5%', '5% mensual de rendimiento', '5 USDT al día', '$5 cada día'],
  pt: ['lucros garantidos', 'garantimos renda', 'sem risco', 'risco zero', 'juros de 5%', '5% mensal de retorno', '5 USDT por dia', '$5 por dia'],
  fr: ['revenus garantis', 'garantissons des gains', 'sans risque', 'zéro risque', 'rendement de 5%', '5% mensuel de rendement', '5 USDT par jour', '$5 chaque jour'],
  de: ['garantierte Rendite', 'Rendite garantiert', 'risikofrei', 'ohne Risiko', 'Rendite von 5%', '5% monatliche Rendite', '5 USDT pro Tag', 'täglich 5 USDT'],
  ja: ['収益保証', '利益を保証します', 'リスクゼロ', '無リスク', '月利5%', '５％の収益', '毎日5 USDT', '5 USDT毎月'],
  ko: ['수익 보장!', '보장된 수익', '무위험', '위험 제로', '월 수익률 5%', '5%의 수익', '매일 5 USDT', '5 USDT 매월'],
};
const green = {
  es: ['no garantiza ingresos', 'rendimientos no garantizados', 'comisión de red del 5%', 'disponibilidad del 99.7%', 'el 30% de las comisiones se quema', 'retirar 5 USDT', 'ingresos variables según las tareas', 'crecimiento interanual de ventas: 117%'],
  pt: ['não garantimos renda', 'lucros não garantidos', 'taxa de rede de 5%', 'disponibilidade de 99.7%', '30% das taxas são queimadas', 'retirar 5 USDT', 'ganhos variam com as tarefas', 'crescimento anual de vendas: 117%'],
  fr: ['ne garantit pas les revenus', 'revenus non garantis', 'frais de réseau de 5%', 'disponibilité de 99.7%', '30% des frais sont brûlés', 'retirer 5 USDT', 'gains variables selon les tâches', 'croissance annuelle des ventes : 117%'],
  de: ['nicht garantierte Rendite', 'Rendite wird nicht garantiert', 'Netzwerkgebühr von 5%', 'Verfügbarkeit von 99.7%', '30% der Gebühren werden verbrannt', '5 USDT auszahlen', 'Vergütung hängt von Aufgaben ab', 'Umsatzwachstum gegenüber Vorjahr: 117%'],
  ja: ['収益を保証しません', '無リスクではありません', 'ネットワーク手数料5%', '稼働率99.7%', '手数料の30%をバーン', '5 USDTを出金', '報酬はタスクによって変動', '売上高の前年同期比117%'],
  ko: ['수익을 보장하지 않습니다', '무위험이 아닙니다', '네트워크 수수료 5%', '가동률 99.7%', '수수료의 30% 소각', '5 USDT 출금', '보상은 작업에 따라 변동', '전년 대비 매출 증가 117%'],
};
let checks = 0;
for (const [locale, cases] of Object.entries(red)) for (const value of cases) {
  assert(scanForbidden(value).length > 0, `${locale} bypassed: ${value}`); checks++;
}
for (const [locale, cases] of Object.entries(green)) for (const value of cases) {
  assert.equal(scanForbidden(value).length, 0, `${locale} false positive: ${value}`); checks++;
}
// Old-language contracts remain active after adding the new families.
for (const value of ['guaranteed returns', '5% monthly income', '稳赚', '保证收益', 'lợi nhuận đảm bảo']) {
  assert(scanForbidden(value).length > 0, `legacy bypassed: ${value}`); checks++;
}
const root = fileURLToPath(new URL('..', import.meta.url));
for (const locale of LOCALES) {
  for (const file of [join(root, `src/i18n/${locale}.json`), ...readdirSync(join(root, `src/content/learn/${locale}`)).filter((name) => name.endsWith('.md')).map((name) => join(root, `src/content/learn/${locale}`, name))]) {
    assert.deepEqual(scanForbidden(readFileSync(file, 'utf8')), [], `authored copy rejected: ${file}`); checks++;
  }
}
console.log(`[forbidden-locales] ${checks} pass`);
