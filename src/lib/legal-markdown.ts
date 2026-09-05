const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const safeHref = (value: string): string | null => {
  const href = value.trim();
  /* 协议相对 URL (`//host`) 与反斜杠变体会跨站，只有单斜杠路径算站内。 */
  if (/^\/(?![\\/])/.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return href;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

function inlineMarkdown(source: string): string {
  const links: string[] = [];
  const withTokens = source.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_all, label: string, rawHref: string) => {
    const href = safeHref(rawHref);
    const safeLabel = inlineMarkdown(label);
    const html = href
      ? `<a href="${escapeHtml(href)}"${href.startsWith('https:') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${safeLabel}</a>`
      : safeLabel;
    const token = `\uE000${links.length}\uE001`;
    links.push(html);
    return token;
  });
  let html = escapeHtml(withTokens);
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return html.replace(/\uE000(\d+)\uE001/g, (_all, index: string) => links[Number(index)] ?? '');
}

const isTableDivider = (line: string) =>
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

const isBlockStart = (line: string, next = '') =>
  /^#{1,6}\s+/.test(line) || /^\s*[-+*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || (line.includes('|') && isTableDivider(next));

/**
 * 后台已做白名单清洗；站侧仍先转义全部 HTML，再只生成约定的标题、段落、列表、链接、强调和表格。
 * 返回首个一级标题供页面壳使用，避免 Markdown 的 H1 被塞进正文卡片。
 */
export function renderLegalMarkdown(markdown: string): { title: string | null; html: string } {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  while (lines[0]?.trim() === '') lines.shift();
  let title: string | null = null;
  if (/^#\s+/.test(lines[0] ?? '')) title = lines.shift()!.replace(/^#\s+/, '').trim();
  while (lines[0]?.trim() === '') lines.shift();

  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(2, heading[1].length + 1));
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (i + 1 < lines.length && line.includes('|') && isTableDivider(lines[i + 1])) {
      const heads = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${heads.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((row) => `<tr>${heads.map((_, index) => `<td>${inlineMarkdown(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    const unordered = /^\s*[-+*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      const pattern = orderedList ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
      while (i < lines.length) {
        const match = pattern.exec(lines[i]);
        if (!match) break;
        items.push(`<li>${inlineMarkdown(match[1])}</li>`);
        i++;
      }
      const tag = orderedList ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1] ?? '')) paragraph.push(lines[i++].trim());
    out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }
  return { title, html: out.join('\n') };
}
