import { LOCALE_NAMES, type Locale } from '../../../schema/src/locales';
import { countInputCharacters, getTextLimit } from './text-limits';

export function TextLimitHint({ id, fieldId, locale, value, immediate = false }: {
  id: string; fieldId: string; locale: Locale; value: string; immediate?: boolean;
}) {
  const rule = getTextLimit(fieldId, locale);
  const count = countInputCharacters(value, locale);
  const over = rule.kind === 'bounded' && rule.limit !== undefined && count > rule.limit;
  const name = rule.key === 'sku.name' ? '全部语言共用名称' : LOCALE_NAMES[locale];
  const newlines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').length - 1;
  const changedBreaks = rule.basis === 'reference' && rule.reference !== undefined && newlines(value) !== newlines(rule.reference);
  const guidance = rule.kind === 'bounded'
    ? rule.limit === undefined ? '需检查前台预览' : rule.basis === 'reference'
      ? name + '按默认断行建议约 ' + rule.limit + ' 字符'
      : name + '建议最多 ' + rule.limit + ' 字符'
    : rule.kind === 'flowing' ? '可自动换行，无固定排版上限'
    : rule.kind === 'metadata' ? '辅助说明文字'
    : rule.kind === 'seo' ? '搜索展示文案'
    : rule.kind === 'system' ? '链接或联系信息，按实际内容填写'
    : '尚未校准建议长度，请检查前台效果';
  return <p id={id} className="kv" data-text-limit-key={rule.key} data-text-limit-over={over}
    data-count={count} data-limit={rule.limit} data-text-limit-basis={rule.basis} style={{ margin: '6px 0 0', color: over ? 'var(--bad)' : undefined }}>
    已输入 {count} 字符 · {guidance}
    {over && <span style={{ display: 'block' }}>已超出建议长度 {count - rule.limit!} 字符，{rule.basis === 'reference' ? '可能增加行数或改变原有排版比例。' : '可能导致换行过多、内容被截断或排版错乱。'}{immediate ? '仅超出排版建议时仍可应用规则，原有系统校验仍适用。' : '仅超出排版建议时仍可保存和发布，原有系统校验仍适用。'}</span>}
    {rule.previewReason && <span style={{ display: 'block' }}>{rule.previewReason}</span>}
    {rule.kind === 'system' && rule.key === 'footer.contactEmail' && <span style={{ display: 'block' }}>{rule.description}</span>}
    {changedBreaks && <span style={{ display: 'block' }}>手动换行数量与默认文案不同，实际行数可能变化，请结合前台预览检查。</span>}
    {rule.syntax && <span style={{ display: 'block' }}>{rule.syntax === 'template'
      ? rule.kind === 'metadata' ? '空格、换行和占位符均计入字数；占位符替换后用于辅助说明。' : '空格、换行和占位符均计入字数；占位符替换后的内容会影响实际宽度。'
      : '空格、换行和格式标记均计入字数；强调文字与引用会影响实际宽度。'}</span>}
  </p>;
}
