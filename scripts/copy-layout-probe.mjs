import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

/** Browser-serializable probe. All candidates extend the exact approved reference. */
export function measureSpecimen({ selector, boundary, constraint = 'inline', basis = 'container', source, locale = 'en', corpus = ' more text', ceiling = 512, inspectOnly = false }) {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  const segments = (value) => [...segmenter.segment(value)].map((part) => part.segment);
  const count = (value) => segments(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')).length;
  const box = (element) => {
    const value = element.getBoundingClientRect();
    return Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map((key) => [key, value[key]]));
  };
  const shown = (element) => {
    if (!element.getClientRects().length || !box(element).width) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const excluded = 'svg, .arr, .ic, .serial, .qdot, .xbtn-ghost, .xbtn-b';
  const textNodes = (host, includeMirrors = false) => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), result = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest(includeMirrors ? 'svg, .arr, .ic, .serial, .qdot' : excluded)) continue;
      if (node.textContent) result.push(node);
    }
    return result;
  };
  const union = (rectangles) => rectangles.length ? {
    left: Math.min(...rectangles.map((r) => r.left)), right: Math.max(...rectangles.map((r) => r.right)),
    top: Math.min(...rectangles.map((r) => r.top)), bottom: Math.max(...rectangles.map((r) => r.bottom)),
  } : null;
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  const uncertain = (reason) => ({ uncertainty: reason });

  function measureInk(host) {
    if (!context) return uncertain('Canvas 字形测量不可用');
    const runs = [], geometry = { box: box(host), units: 'screen-px', visualLineCount: 0, lines: [] };
    for (const node of textNodes(host)) {
      const parent = node.parentElement;
      if (!shown(parent)) continue;
      const style = getComputedStyle(parent), size = parseFloat(style.fontSize);
      const preciseZoom = parent.currentCSSZoom;
      const hasPreciseZoom = Number.isFinite(preciseZoom) && preciseZoom > 0;
      let zoom = hasPreciseZoom ? preciseZoom : 1;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        const current = getComputedStyle(ancestor);
        if (!hasPreciseZoom) zoom *= parseFloat(current.zoom) || 1;
        if (current.transform !== 'none') {
          const matrix = new DOMMatrixReadOnly(current.transform);
          if (!matrix.is2D || Math.abs(matrix.a - 1) > 0.0001 || Math.abs(matrix.d - 1) > 0.0001 || Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001) {
            return uncertain('缩放或旋转变换下无法精确测量字形');
          }
        }
      }
      if (!['none', 'uppercase', 'lowercase'].includes(style.textTransform)) return uncertain('当前文字转换无法精确测量');
      if (!['normal', '100%'].includes(style.fontStretch)) return uncertain('当前字体拉伸无法精确测量');
      if (style.direction !== 'ltr' || /[\u0590-\u08ff]/.test(node.textContent)) return uncertain('双向文字无法可靠对应当前行测量');
      const letterSpacing = `${(parseFloat(style.letterSpacing) || 0) * zoom}px`;
      const wordSpacing = `${(parseFloat(style.wordSpacing) || 0) * zoom}px`;
      if ((!('letterSpacing' in context) && parseFloat(letterSpacing)) || (!('wordSpacing' in context) && parseFloat(wordSpacing))) return uncertain('Canvas 不支持当前字距');
      const cssFont = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
      // Chromium resolves glyph metrics at the effective font size, then rounds.
      // Multiplying already-rounded 12px metrics by 4/3 is not a 16px font.
      const font = `${style.fontStyle} ${style.fontWeight} ${size * zoom}px ${style.fontFamily}`;
      const signature = JSON.stringify([font, letterSpacing, wordSpacing, style.textTransform, zoom]);
      const language = parent.closest('[lang]')?.getAttribute('lang') || locale;
      const transform = (text) => style.textTransform === 'uppercase' ? text.toLocaleUpperCase(language)
        : style.textTransform === 'lowercase' ? text.toLocaleLowerCase(language) : text;
      // A single text-node line already has one font and one baseline. Reading
      // its complete Range avoids a DOM query for every grapheme of each trial.
      const whole = document.createRange();
      whole.selectNodeContents(node);
      let wholeRectangles = [...whole.getClientRects()].filter((r) => r.width > 0.001 && r.height > 0);
      // Chromium reports the full advance and an overlapping visible fragment
      // for text-overflow:ellipsis. The complete line is needed to test clipping.
      if (style.textOverflow === 'ellipsis' && wholeRectangles.length > 1) {
        const complete = wholeRectangles.reduce((a, b) => a.width > b.width ? a : b);
        if (wholeRectangles.every((r) => Math.abs(r.top - complete.top) < 0.5 && Math.abs(r.bottom - complete.bottom) < 0.5
          && r.left >= complete.left - 0.5 && r.right <= complete.right + 0.5)) wholeRectangles = [complete];
      }
      if (wholeRectangles.length === 1 && !/[\r\n\t]/.test(node.textContent)) {
        let start = 0, end = node.textContent.length;
        const collapsed = ['normal', 'nowrap', 'pre-line'].includes(style.whiteSpace);
        if (collapsed) {
          // Leading/trailing collapsed spaces can belong to the HTML source but
          // have zero advance. Preserve spaces that actually separate an icon.
          const hasAdvance = (offset) => {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
            return [...range.getClientRects()].some((r) => r.width > 0.001);
          };
          while (start < end && node.textContent[start] === ' ' && !hasAdvance(start)) start++;
          while (end > start && node.textContent[end - 1] === ' ' && !hasAdvance(end - 1)) end--;
        }
        let text = node.textContent.slice(start, end);
        if (collapsed) text = text.replace(/ {2,}/g, ' ');
        const rectangle = wholeRectangles[0];
        runs.push({ signature, font, cssFont, letterSpacing, wordSpacing, zoom, text: transform(text), rect: {
          left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom, height: rectangle.height,
        }, parent });
        continue;
      }
      // For ordinary LTR wrapping, Range supplies ordered line boxes. Locate
      // each line's final grapheme by its Y coordinate; candidate lengths are
      // still tested sequentially below. Non-uniform fragments use the slower
      // per-grapheme path, whose checks fail closed for unsupported typography.
      if (wholeRectangles.length > 1 && wholeRectangles.every((r, i) => !i || r.top > wholeRectangles[i - 1].top + 0.5)) {
        const parts = [...segmenter.segment(node.textContent)], positions = new Map();
        const position = (index) => {
          if (positions.has(index)) return positions.get(index);
          const part = parts[index], range = document.createRange();
          range.setStart(node, part.index); range.setEnd(node, part.index + part.segment.length);
          const rectangles = [...range.getClientRects()].filter((r) => r.height > 0);
          const rectangle = rectangles.length === 1 ? rectangles[0]
            : rectangles.length && rectangles.every((r) => r.width <= 0.001) ? rectangles[0] : null;
          positions.set(index, rectangle);
          return rectangle;
        };
        let start = 0;
        for (const line of wholeRectangles) {
          let low = start, high = parts.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2), rectangle = position(middle);
            if (!rectangle) return uncertain('文字片段无法可靠对应视觉行');
            if (rectangle.top <= line.top + 0.5) low = middle + 1;
            else high = middle;
          }
          const next = low;
          let first = start, last = next - 1;
          while (first <= last && position(first)?.width <= 0.001) first++;
          while (last >= first && position(last)?.width <= 0.001) last--;
          if (first <= last) {
            const range = document.createRange();
            range.setStart(node, parts[first].index); range.setEnd(node, parts[last].index + parts[last].segment.length);
            const rectangles = [...range.getClientRects()].filter((r) => r.width > 0.001 && r.height > 0);
            if (rectangles.length !== 1 || Math.abs(rectangles[0].top - line.top) > 0.5) return uncertain('字形与视觉行边界无法精确对应');
            let text = node.textContent.slice(parts[first].index, parts[last].index + parts[last].segment.length);
            if (['normal', 'nowrap', 'pre-line'].includes(style.whiteSpace)) text = text.replace(/[\t\r\n ]+/g, ' ');
            else if (/[\r\n\t]/.test(text)) return uncertain('当前保留空白无法精确对应字形宽度');
            const rectangle = rectangles[0];
            runs.push({ signature, font, cssFont, letterSpacing, wordSpacing, zoom, text: transform(text), rect: {
              left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom, height: rectangle.height,
            }, parent });
          }
          start = next;
        }
        if (start !== parts.length) return uncertain('仍有文字未对应到视觉行');
        continue;
      }
      for (const part of segmenter.segment(node.textContent)) {
        const range = document.createRange();
        range.setStart(node, part.index); range.setEnd(node, part.index + part.segment.length);
        const rectangles = [...range.getClientRects()].filter((r) => r.width > 0.001 && r.height > 0);
        if (rectangles.length > 1) return uncertain('单个字素跨多个布局片段，无法精确测量');
        if (!rectangles.length) continue;
        const rectangle = rectangles[0];
        const text = transform(part.segment);
        const last = runs.at(-1);
        if (last && last.signature === signature && Math.abs(last.rect.top - rectangle.top) < 0.5 && Math.abs(last.rect.bottom - rectangle.bottom) < 0.5
          && Math.abs(last.rect.right - rectangle.left) < Math.max(2, zoom)) {
          last.text += text; last.rect.right = rectangle.right;
        } else runs.push({ signature, font, cssFont, letterSpacing, wordSpacing, zoom, text, rect: {
          left: rectangle.left, right: rectangle.right, top: rectangle.top, bottom: rectangle.bottom, height: rectangle.height,
        }, parent });
      }
    }
    for (const run of runs) {
      context.font = run.font;
      context.textAlign = 'left'; context.textBaseline = 'alphabetic';
      if ('letterSpacing' in context) context.letterSpacing = run.letterSpacing;
      if ('wordSpacing' in context) context.wordSpacing = run.wordSpacing;
      const metrics = context.measureText(run.text);
      const ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
      if (![ascent, descent, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight].every(Number.isFinite)) return uncertain('字体未提供完整字形度量');
      if (Math.abs((ascent + descent) - run.rect.height) > Math.max(1.1, run.zoom)) return uncertain('字体或混合字形行框无法与实际字体度量对齐');
      if (Math.abs(metrics.width - (run.rect.right - run.rect.left)) > Math.max(2, run.zoom)) return uncertain('字体特性或混合字体的实际宽度无法精确还原');
      if (!metrics.actualBoundingBoxAscent && !metrics.actualBoundingBoxDescent) continue;
      const baseline = run.rect.top + ascent;
      const ink = { left: run.rect.left - metrics.actualBoundingBoxLeft,
        right: run.rect.left + metrics.actualBoundingBoxRight,
        top: baseline - metrics.actualBoundingBoxAscent,
        bottom: baseline + metrics.actualBoundingBoxDescent };
      geometry.lines.push({ text: run.text, font: run.font, cssFont: run.cssFont, zoom: run.zoom,
        letterSpacing: run.letterSpacing, wordSpacing: run.wordSpacing, baseline, range: run.rect, ink });
      run.ink = ink;
    }
    if (!geometry.lines.length) return uncertain('当前没有可测量的可见字形');
    const baselines = [];
    for (const line of geometry.lines) if (!baselines.some((value) => Math.abs(value - line.baseline) < 1)) baselines.push(line.baseline);
    geometry.visualLineCount = baselines.length;
    geometry.ink = union(geometry.lines.map((line) => line.ink));
    return { geometry, runs: runs.filter((run) => run.ink) };
  }

  function physical(host, measured) {
    const card = host.closest('#devices .card');
    const transparent = (color) => color === 'transparent'
      || (/^rgba\(/.test(color) && /,\s*0(?:\.0+)?\)$/.test(color)) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
    for (const run of measured.runs) {
      const transparentFill = transparent(getComputedStyle(run.parent).webkitTextFillColor);
      for (let ancestor = run.parent; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = box(ancestor);
        // A text-clipped background only paints within its own element box.
        // Transparent glyphs outside that box disappear even with overflow:
        // visible; ordinary opaque italic overhang remains legal.
        if (transparentFill && style.backgroundClip.split(',').some((value) => value.trim() === 'text')
          && (style.backgroundImage !== 'none' || !transparent(style.backgroundColor))) {
          measured.geometry.paintedText ??= [];
          measured.geometry.paintedText.push({ element: ancestor.tagName.toLowerCase() + (ancestor.className ? '.' + ancestor.className.trim().split(/\s+/).join('.') : ''), bounds, ink: run.ink });
          if (run.ink.left < bounds.left - 1 || run.ink.right > bounds.right + 1 || run.ink.top < bounds.top - 1 || run.ink.bottom > bounds.bottom + 1) return '渐变文字超出背景绘制范围';
        }
        // Deck choreography deliberately parks complete cards beyond this frame.
        // Their own text must still fit the card; moving the card is not overflow.
        if (card?.closest('#devices.decked') && ancestor.matches('.x-frame')) continue;
        if (['clip', 'hidden'].includes(style.overflowX) && (run.ink.left < bounds.left - 1 || run.ink.right > bounds.right + 1)) return '文字被横向裁切';
        if (['clip', 'hidden'].includes(style.overflowY) && (run.ink.top < bounds.top - 1 || run.ink.bottom > bounds.bottom + 1)) return '文字被纵向裁切';
      }
    }
    if (host.closest('.site-nav')) {
      const navigation = host.closest('.site-nav'), bounds = box(navigation.querySelector('nav') || navigation);
      const controls = [...navigation.querySelectorAll('.logo, .links > a, .h5, .dl-btn, .lang-picker > summary')].filter(shown);
      for (let i = 0; i < controls.length; i++) {
        const current = box(controls[i]);
        if (current.left < bounds.left - 1 || current.right > bounds.right + 1) return '导航控件超出可用宽度';
        for (let j = i + 1; j < controls.length; j++) if (!controls[i].contains(controls[j]) && !controls[j].contains(controls[i]) && overlap(current, box(controls[j]))) return '导航控件相互遮挡';
      }
    }
    if (host.closest('.hero')) {
      const nav = document.querySelector('.site-nav');
      if (nav && shown(nav)) {
        const bounds = box(nav), blocked = measured.runs.find((run) => overlap(run.ink, bounds));
        if (blocked) { measured.geometry.navOverlay = { bounds, ink: blocked.ink }; return 'Hero 文字被导航遮挡'; }
      }
    }
    if (card) {
      const bounds = box(card), ink = measured.geometry.ink;
      if (ink.left < bounds.left - 1 || ink.right > bounds.right + 1 || ink.top < bounds.top - 1 || ink.bottom > bounds.bottom + 1) return '设备文字超出卡片范围';
      const media = card.querySelector('.media');
      if (media && box(media).height <= 1) return '设备图片区消失';
      const chip = card.querySelector('.chip'), serial = card.querySelector('.serial');
      if (chip && serial && shown(chip) && shown(serial) && overlap(box(chip), box(serial))) return '设备状态章与编号重叠';
    }
    if (host.matches('.cert-hint')) {
      const certificate = host.closest('.cert-open');
      if (certificate) {
        const bounds = box(certificate), ink = measured.geometry.ink;
        if (ink.left < bounds.left - 1 || ink.right > bounds.right + 1 || ink.top < bounds.top - 1 || ink.bottom > bounds.bottom + 1) return '证书提示超出图片区域';
      }
    }
    const plate = host.closest('.final .plate');
    if (plate) {
      const media = plate.querySelector('.pmedia');
      if (media && shown(media)) for (const button of [...plate.querySelectorAll('.dl > *')].filter(shown)) {
        if (overlap(box(button), box(media))) return '下载按钮与配图重叠';
      }
    }
    return null;
  }

  function inspectLayout(host, measured, boundaryElement) {
    const failure = physical(host, measured);
    if (failure) return { failure };
    if (constraint === 'inline' && boundaryElement) {
      const bounds = box(boundaryElement), control = box(host.closest('.xbtn') || host);
      if (control.left < bounds.left - 1 || control.right > bounds.right + 1) {
        return { failure: '文字或控件超出指定横向空间' };
      }
    }
    const group = host.closest('.hero') ? '.hero .cluster h1, .hero .left .note, .hero .left .note2, .hero .subs .sub, .hero .subs .sub2, .hero .scroll-hint .txt'
      : host.closest('#social') ? '#social .kicker .x-mono-lg, #social .disp h2, #social .roles'
      : host.closest('#mission') ? '#mission .ktxt, #mission .state, #mission .body, #mission .cell .name, #mission .cell .idx'
        : host.closest('#devices .gutter') ? '#devices .gutter .lab, #devices .gutter .sub, #devices .gutter .cta' : null;
    const siblings = group ? [...document.querySelectorAll(group)].filter(shown) : [];
    const metadataRow = host.closest('.metarow');
    if (metadataRow) siblings.push(...[...metadataRow.children].filter(shown));
    const related = [];
    for (const sibling of new Set(siblings)) {
      const target = sibling.querySelector('.xbtn-a, .static') || sibling;
      const current = target === host ? measured : measureInk(target);
      if (current.uncertainty) return { uncertainty: '同区域文字无法精确测量：' + current.uncertainty };
      const siblingFailure = target === host ? null : physical(target, current);
      related.push({ selector: sibling.tagName.toLowerCase() + (sibling.className ? '.' + sibling.className.trim().split(/\s+/).join('.') : ''), ...current.geometry });
      if (siblingFailure) { measured.geometry.related = related; return { failure: '同区域内容：' + siblingFailure }; }
    }
    if (metadataRow) for (let i = 0; i < related.length; i++) for (let j = i + 1; j < related.length; j++) {
      if (overlap(related[i].ink, related[j].ink)) { measured.geometry.related = related; return { failure: '元信息文字相互遮挡' }; }
    }
    if (related.length) measured.geometry.related = related;
    return { failure: null };
  }

  const observations = [];
  const visibleElements = [...document.querySelectorAll(selector)].filter(shown);
  for (const element of visibleElements) {
    const host = element.querySelector('.xbtn-a, .static') || element;
    const record = { reference: typeof source === 'string' ? source : '', referenceLength: typeof source === 'string' ? count(source) : 0,
      basis, geometry: {}, referenceFailure: null, status: 'preview' };
    observations.push(record);
    const boundaryElement = !boundary ? null : boundary === 'html' ? document.documentElement : boundary === 'body' ? document.body : element.closest(boundary);
    if (boundary && !boundaryElement) { Object.assign(record, { missingBoundary: true, reason: '缺少指定布局边界' }); continue; }
    const allNodes = textNodes(element, true);
    let reference = source, mutation;
    if (reference === undefined) {
      if (element.children.length || allNodes.length !== 1) { Object.assign(record, { missingText: true, reason: '未指定原文且目标不是单一纯文本节点' }); continue; }
      reference = allNodes[0].textContent;
    }
    if (!reference?.trim()) { Object.assign(record, { missingText: true, reason: '缺少非空原样参考文案' }); continue; }
    record.reference = reference; record.referenceLength = count(reference);
    let renderedReference = reference;
    const trimsReference = element.matches('.announcement .message');
    if (trimsReference) renderedReference = reference.trim();
    if (element.getAttribute('data-scale-template') === reference && reference.includes('{')) {
      const tokens = [...reference.matchAll(/\{([A-Za-z0-9_]+)\}/g)];
      if (tokens.length) {
        const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let pattern = '', offset = 0;
        for (const token of tokens) { pattern += escape(reference.slice(offset, token.index)) + '(.+?)'; offset = token.index + token[0].length; }
        pattern += escape(reference.slice(offset));
        const actual = host.textContent.trim(), values = new RegExp('^' + pattern + '$', 's').exec(actual);
        if (!values) { Object.assign(record, { missingText: true, reason: '无法将模板占位符对应到已渲染值' }); continue; }
        const replacements = Object.fromEntries(tokens.map((token, index) => [token[1], values[index + 1]]));
        renderedReference = reference.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name) => replacements[name] ?? token);
        record.templateValues = replacements;
      }
    }
    const paragraphs = element.matches('#mission .body') ? [...element.querySelectorAll(':scope > p')] : [];
    if (paragraphs.length && paragraphs.map((p) => p.textContent).join('\n') === reference) {
      const children = [...element.childNodes], last = paragraphs.at(-1), original = last.textContent;
      if (last.children.length || last.childNodes.length !== 1 || last.firstChild.nodeType !== Node.TEXT_NODE) {
        Object.assign(record, { missingText: true, reason: '多段原文含未支持的混合标记' }); continue;
      }
      const node = last.firstChild;
      const restore = () => { node.textContent = original; element.replaceChildren(...children); };
      mutation = { restore, apply(value) {
        restore();
        const extra = value.slice(reference.length).split('\n');
        node.textContent = original + extra[0];
        for (const text of extra.slice(1)) { const paragraph = last.cloneNode(false); paragraph.append(document.createTextNode(text)); element.append(paragraph); }
      } };
    } else {
      const matches = allNodes.filter((node) => node.textContent.includes(renderedReference));
      const button = element.matches('.xbtn') || Boolean(element.querySelector('.xbtn-a, .static'));
      if (!matches.length && visibleElements.length > 1) { observations.pop(); continue; }
      if (!matches.length || (!button && matches.length !== 1)) { Object.assign(record, { missingText: true, reason: '无法唯一对应原文文本节点' }); continue; }
      const originals = matches.map((node) => [node, node.textContent]);
      mutation = { restore() { for (const [node, value] of originals) node.textContent = value; },
        apply(value) {
          const rendered = trimsReference ? value.trim() : renderedReference + value.slice(reference.length);
          for (const [node, before] of originals) node.textContent = before.replace(renderedReference, rendered);
        } };
    }
    try {
      const initial = measureInk(host);
      if (initial.uncertainty) { record.reason = initial.uncertainty; record.unresolved = true; continue; }
      const media = element.closest('#devices .card')?.querySelector('.media');
      const mediaHeight = media ? box(media).height : null;
      const baselineLayout = inspectLayout(host, initial, boundaryElement);
      record.geometry = { ...initial.geometry, boundary: boundaryElement ? box(boundaryElement) : null, mediaHeight, constraint };
      if (baselineLayout.uncertainty) { record.reason = baselineLayout.uncertainty; record.unresolved = true; continue; }
      record.referenceFailure = baselineLayout.failure;
      if (record.referenceFailure) { record.reason = '原样文案已有物理异常，需预览确认'; continue; }
      if (inspectOnly) { record.reason = '仅检查原样物理几何'; continue; }
      const additions = segments(' ' + (corpus || ' more text').repeat(Math.ceil((ceiling + 2) / Math.max(1, segments(corpus || ' more text').length)) + 1));
      const menu = element.closest('.site-nav .menu'), elementStyle = getComputedStyle(element);
      if (element.matches('.site-nav .links > a') && elementStyle.whiteSpace === 'normal' && elementStyle.overflowWrap === 'anywhere'
        && menu && getComputedStyle(menu).position === 'fixed' && ['auto', 'scroll'].includes(getComputedStyle(menu).overflowY) && ceiling >= 512) {
        // The mobile menu explicitly wraps each link and scrolls vertically.
        // Its total text has no fixed height budget. Verify a complete long
        // sample instead of searching 512 intermediate lengths for a false cap.
        const candidate = reference + additions.slice(0, Math.floor(ceiling)).join('');
        mutation.apply(candidate);
        const measured = measureInk(host);
        record.testedThrough = count(candidate);
        if (measured.uncertainty) { record.reason = measured.uncertainty; record.unresolved = true; continue; }
        const layout = inspectLayout(host, measured, boundaryElement);
        record.flowing = { condition: '移动导航链接自动换行、菜单允许纵向滚动', candidate, geometry: measured.geometry,
          heightBefore: initial.geometry.box.height, heightAfter: measured.geometry.box.height,
          menu: { clientHeight: menu.clientHeight, scrollHeight: menu.scrollHeight, clientWidth: menu.clientWidth, scrollWidth: menu.scrollWidth } };
        if (layout.uncertainty || layout.failure || menu.scrollWidth > menu.clientWidth + 1 || measured.geometry.box.height <= initial.geometry.box.height) {
          record.reason = layout.uncertainty || layout.failure || '未能证明长文在移动导航中完整展开';
          record.unresolved = true;
        } else record.reason = '移动导航已验证自动换行及纵向滚动，不生成固定字数上限';
        continue;
      }
      const flowingSection = constraint === 'section' && matchMedia('(max-width: 860px)').matches ? element.closest('#mission, #social') : null;
      if (flowingSection && ceiling > 0) {
        // Both component styles explicitly switch to height:auto at <=860px.
        // A long sample must demonstrate actual expansion and preserve every
        // related text item. If it fails, search all intermediate lengths below.
        const before = box(flowingSection), candidate = reference + additions.slice(0, Math.floor(ceiling)).join('');
        mutation.apply(candidate);
        const measured = measureInk(host);
        if (measured.uncertainty) { record.reason = measured.uncertainty; record.unresolved = true; continue; }
        const layout = inspectLayout(host, measured, boundaryElement), after = box(flowingSection);
        record.flowingTrial = { condition: '移动 Mission/Social 的 height:auto 与最小高度下限', candidate, testedLength: count(candidate),
          before, after, geometry: measured.geometry, failure: layout.failure || null };
        if (layout.uncertainty) { record.reason = layout.uncertainty; record.unresolved = true; continue; }
        if (!layout.failure && after.height > before.height + 1) {
          record.flowing = record.flowingTrial;
          delete record.flowingTrial;
          record.testedThrough = count(candidate);
          record.reason = '移动区块已验证随长文增高、同区文字完整，不生成固定字数上限';
          continue;
        }
        mutation.restore();
      }
      let accepted = reference;
      for (let extra = 1; extra <= Math.max(0, Math.floor(ceiling)); extra++) {
        const candidate = reference + additions.slice(0, extra).join('');
        mutation.apply(candidate);
        const measured = measureInk(host);
        record.testedThrough = count(candidate);
        if (measured.uncertainty) { record.reason = measured.uncertainty; record.unresolved = true; break; }
        const layout = inspectLayout(host, measured, boundaryElement);
        if (layout.uncertainty) { record.reason = layout.uncertainty; record.unresolved = true; break; }
        const actualFailure = layout.failure;
        const changedReference = basis === 'reference' && (measured.geometry.visualLineCount > initial.geometry.visualLineCount
          || (media && box(media).height < mediaHeight - 1));
        const failure = actualFailure || (changedReference ? '超出默认版式参考' : null);
        if (failure) {
          Object.assign(record, { status: 'measured', limit: count(accepted), accepted, failing: candidate, failingLength: count(candidate), reason: failure,
            acceptedGeometry: record.lastAcceptedGeometry || record.geometry, failingGeometry: { ...measured.geometry, mediaHeight: media ? box(media).height : null } });
          delete record.lastAcceptedGeometry;
          break;
        }
        accepted = candidate;
        record.lastAcceptedGeometry = { ...measured.geometry, mediaHeight: media ? box(media).height : null };
      }
      if (record.status !== 'measured' && !record.reason) record.reason = '测试范围内未观察到固定边界，不生成数字上限';
      delete record.lastAcceptedGeometry;
    } finally { mutation.restore(); }
  }
  return { observed: observations.length, observations, candidates: visibleElements.length, domCandidates: document.querySelectorAll(selector).length };
}

export async function selfTest() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 400 } });
    const probe = (input) => page.evaluate(measureSpecimen, input);
    await page.setContent('<section class="hero" style="height:auto;min-height:500px;overflow:hidden"><h1 style="font:20px/24px Arial;white-space:pre-line">NexGrid\nLet compute flow</h1></section>');
    let result = await probe({ selector: 'h1', boundary: '.hero', source: 'NexGrid\nLet compute flow', inspectOnly: true });
    assert.equal(result.observations[0].referenceLength, 24);
    assert.equal(result.observations[0].referenceFailure, null, 'Natural growth below the fold is not clipping.');
    await probe({ selector: 'h1', boundary: '.hero', basis: 'reference', source: 'NexGrid\nLet compute flow', corpus: ' more', ceiling: 30 });
    assert.equal(await page.locator('h1').textContent(), 'NexGrid\nLet compute flow');
    await page.setContent('<h1 style="width:80px;font:40px/48px Arial;white-space:nowrap;background:linear-gradient(white,gray);background-clip:text;-webkit-text-fill-color:transparent"><span>WWWW</span></h1>');
    result = await probe({ selector: 'h1', source: 'WWWW', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, '渐变文字超出背景绘制范围');
    assert.equal(result.observations[0].limit, undefined);
    assert.ok(result.observations[0].geometry.paintedText.length);
    await page.setContent('<header class="site-nav" style="position:fixed;inset:0 0 auto;height:60px"></header><section class="hero"><div class="left"><p class="note" style="margin:0;position:absolute;top:30px;font:20px/24px Arial">Note</p></div><div class="cluster" style="padding-top:100px"><h1 style="font:20px/24px Arial">Hello</h1></div></section>');
    result = await probe({ selector: '.note', source: 'Note', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, 'Hero 文字被导航遮挡', 'Notes must be checked against the navigation too.');
    result = await probe({ selector: 'h1', source: 'Hello', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, '同区域内容：Hero 文字被导航遮挡', 'A clean title cannot conceal another hero field behind navigation.');
    await page.setContent('<header class="site-nav" style="position:fixed;inset:0 0 auto;height:40px"></header><section class="hero" style="width:120px;height:180px;display:flex;flex-direction:column;justify-content:center;font:20px/24px Arial"><div class="left"><p class="note" style="margin:0">Note</p></div><div class="cluster"><h1 style="font:inherit;margin:0">Hello</h1></div></section>');
    result = await probe({ selector: 'h1', source: 'Hello', corpus: ' more text', ceiling: 100 });
    assert.equal(result.observations[0].referenceFailure, null);
    assert.equal(result.observations[0].reason, '同区域内容：Hero 文字被导航遮挡', 'Title growth must not push a sibling note under navigation.');
    assert.equal(result.observations[0].failingLength, result.observations[0].limit + 1);
    await page.setContent('<div class="box" style="height:18px;overflow:hidden;font:20px/18px Arial"><span>Hello</span></div>');
    result = await probe({ selector: '.box span', boundary: '.box', source: 'Hello', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, null, 'Font line box protrusion is not ink clipping.');
    assert.ok(result.observations[0].geometry.lines.length);
    const monoFont = readFileSync(new URL('../node_modules/@fontsource/space-mono/files/space-mono-latin-400-normal.woff2', import.meta.url)).toString('base64');
    await page.setContent(`<style>@font-face{font-family:ProbeMono;src:url(data:font/woff2;base64,${monoFont}) format('woff2')}</style><div style="zoom:calc(4 / 3)"><span class="zoom" style="font:12px/1.2 ProbeMono;white-space:nowrap">SO FUNKTIONIERT’S</span></div>`);
    await page.evaluate(async () => { await document.fonts.load('12px ProbeMono'); await document.fonts.ready; });
    const zoomMetrics = await page.locator('.zoom').evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const context = document.createElement('canvas').getContext('2d');
      context.font = '12px ProbeMono';
      const raw = context.measureText(element.textContent), zoom = element.currentCSSZoom;
      const serializedZoom = parseFloat(getComputedStyle(element.parentElement).zoom);
      context.font = `${12 * zoom}px ProbeMono`;
      const actual = context.measureText(element.textContent);
      return { rangeHeight: range.getBoundingClientRect().height, zoom, serializedZoom,
        oldHeight: (raw.fontBoundingBoxAscent + raw.fontBoundingBoxDescent) * serializedZoom,
        actualHeight: actual.fontBoundingBoxAscent + actual.fontBoundingBoxDescent };
    });
    assert.ok(Math.abs(zoomMetrics.oldHeight - zoomMetrics.rangeHeight) > Math.max(1.1, zoomMetrics.serializedZoom), 'The real 12px font must reproduce the former zoom rounding rejection.');
    assert.equal(zoomMetrics.actualHeight, zoomMetrics.rangeHeight);
    result = await probe({ selector: '.zoom', source: 'SO FUNKTIONIERT’S', inspectOnly: true });
    assert.equal(result.observations[0].unresolved, undefined, 'Measure font metrics at the actual zoomed font size.');
    assert.equal(result.observations[0].referenceFailure, null);
    assert.equal(result.observations[0].geometry.units, 'screen-px');
    assert.match(result.observations[0].geometry.lines[0].cssFont, /12px/);
    await page.locator('.zoom').evaluate((element) => { element.style.letterSpacing = '1.5px'; element.style.wordSpacing = '2px'; });
    result = await probe({ selector: '.zoom', source: 'SO FUNKTIONIERT’S', inspectOnly: true });
    assert.equal(result.observations[0].unresolved, undefined, 'Letter and word spacing must use the same screen units as the font.');
    assert.equal(result.observations[0].referenceFailure, null);
    await page.locator('.zoom').evaluate((element) => { element.parentElement.style.cssText += ';width:30px;overflow:hidden'; });
    result = await probe({ selector: '.zoom', source: 'SO FUNKTIONIERT’S', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, '文字被横向裁切', 'Correct zoom metrics must still reject genuine clipping.');
    await page.setContent('<div class="box" style="width:100px;overflow:hidden;font:20px/24px Arial;white-space:nowrap"><span>Hello</span></div>');
    result = await probe({ selector: '.box span', boundary: '.box', source: 'Hello', corpus: 'W', ceiling: 30 });
    assert.equal(result.observations[0].status, 'measured');
    assert.match(result.observations[0].reason, /裁切/);
    assert.ok(result.observations[0].failing.startsWith('Hello '));
    assert.equal(result.observations[0].failingLength, result.observations[0].limit + 1);
    await page.setContent('<p style="width:80px;font:20px/24px Arial;overflow-wrap:anywhere">Hi</p>');
    result = await probe({ selector: 'p', source: 'Hi', corpus: 'more text ', ceiling: 30 });
    assert.equal(result.observations[0].status, 'preview');
    assert.equal(result.observations[0].limit, undefined, 'Natural flow must not acquire a ceiling cap.');
    result = await probe({ selector: 'p', basis: 'reference', source: 'Hi', corpus: 'more text ', ceiling: 30 });
    assert.equal(result.observations[0].reason, '超出默认版式参考');
    assert.equal(result.observations[0].failingGeometry.visualLineCount, result.observations[0].geometry.visualLineCount + 1);
    await page.setContent('<section id="mission"><div class="body" style="font:20px/24px Arial;width:180px"><p>First line</p><p>Second line</p></div></section>');
    const before = await page.locator('body').innerHTML();
    result = await probe({ selector: '#mission .body', boundary: '#mission', basis: 'reference', source: 'First line\nSecond line', corpus: '\nThird line', ceiling: 20 });
    assert.equal(await page.locator('body').innerHTML(), before, 'Mission paragraph nodes and attributes must be restored.');
    assert.ok(result.observations[0].failing.startsWith('First line\nSecond line '));
    await page.setContent('<div style="width:120px;overflow:hidden"><a class="xbtn" style="display:block;position:relative;font:20px/24px Arial;white-space:nowrap"><span class="xbtn-ghost" style="visibility:hidden">Open <i class="arr">→</i></span><span class="xbtn-a" style="position:absolute;left:0;top:0">Open <i class="arr">→</i></span><span class="xbtn-b" style="display:none">Open <i class="arr">→</i></span><svg width="4" height="4"></svg></a></div>');
    const buttonBefore = await page.locator('body').innerHTML();
    result = await probe({ selector: '.xbtn', source: 'Open', corpus: 'W', ceiling: 30 });
    assert.equal(result.observations[0].status, 'measured');
    assert.equal(await page.locator('body').innerHTML(), buttonBefore, 'All button faces and icons must be restored.');
    await page.setContent('<h2 data-scale-template="{devices} devices in {countries} countries" style="font:20px/24px Arial;width:240px">28,432 devices in 47 countries</h2><b class="price">Free</b><b class="price">$19.90</b>');
    const templateBefore = await page.locator('body').innerHTML();
    result = await probe({ selector: 'h2', basis: 'reference', source: '{devices} devices in {countries} countries', corpus: ' more words', ceiling: 30 });
    assert.deepEqual(result.observations[0].templateValues, { devices: '28,432', countries: '47' });
    assert.equal(result.observations[0].status, 'measured');
    assert.ok(result.observations[0].failing.startsWith('{devices} devices in {countries} countries '));
    assert.equal(await page.locator('body').innerHTML(), templateBefore, 'Template values and attributes must be restored.');
    result = await probe({ selector: '.price', source: 'Free', inspectOnly: true });
    assert.equal(result.observed, 1, 'Paid prices are not consumers of the editable Free label.');
    await page.setContent('<aside class="announcement"><span class="message" style="display:block;width:100px;overflow:hidden;white-space:nowrap;font:20px/24px Arial">Hello</span></aside>');
    result = await probe({ selector: '.announcement .message', source: ' Hello ', corpus: 'W', ceiling: 20 });
    assert.equal(result.observations[0].reference, ' Hello ', 'Authored spaces belong to the reference even when the component trims rendering.');
    assert.equal(result.observations[0].status, 'measured');
    assert.equal(await page.locator('.message').textContent(), 'Hello');
    await page.locator('.message').evaluate((e) => { e.style.textOverflow = 'ellipsis'; e.textContent = 'Hello WWWWWWWWWWW'; });
    result = await probe({ selector: '.message', source: 'Hello WWWWWWWWWWW', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, '文字被横向裁切', 'Ellipsis fragments are physical clipping, not unknown typography.');
    assert.equal(result.observations[0].unresolved, undefined);
    await page.setContent('<section id="social" style="height:120px;overflow:hidden;display:flex;align-items:center;width:180px;font:20px/20px Arial"><div><p class="kicker" style="margin:0"><span class="x-mono-lg">Kicker</span></p><div class="disp"><h2 style="font:inherit;margin:10px 0">Hello</h2></div><p class="roles" style="margin:0">Roles</p></div></section>');
    result = await probe({ selector: '#social h2', constraint: 'section', boundary: '#social', source: 'Hello', corpus: ' more text', ceiling: 150 });
    assert.equal(result.observations[0].status, 'measured');
    assert.match(result.observations[0].reason, /同区域内容.*裁切/, 'Growth must not push other section text through clipping ancestors.');
    assert.ok(result.observations[0].failingGeometry.related.length);
    await page.locator('#social').evaluate((e) => { e.style.height = 'auto'; e.style.minHeight = '120px'; });
    result = await probe({ selector: '#social h2', constraint: 'section', boundary: '#social', source: 'Hello', corpus: ' more text', ceiling: 150 });
    assert.equal(result.observations[0].limit, undefined);
    assert.ok(result.observations[0].flowing.after.height > result.observations[0].flowing.before.height);
    await page.setContent('<div class="body" style="width:100px"><button style="white-space:nowrap;font:20px/24px Arial">Hello</button></div>');
    result = await probe({ selector: 'button', boundary: '.body', source: 'Hello', corpus: 'W', ceiling: 30 });
    assert.equal(result.observations[0].reason, '文字或控件超出指定横向空间');
    await page.setContent('<div class="body"><span style="display:inline-block;font:italic 40px/48px Arial">f</span></div>');
    await page.locator('.body').evaluate((e) => { e.style.width = e.firstElementChild.getBoundingClientRect().width + 'px'; });
    result = await probe({ selector: '.body span', boundary: '.body', source: 'f', inspectOnly: true });
    assert.equal(result.observations[0].referenceFailure, null, 'Unclipped glyph overhang is not a control crossing its container.');
    await page.setContent('<section class="final"><div class="plate" style="width:300px;position:relative;height:100px"><div class="pmedia" style="width:150px;height:100px"></div><div class="dl" style="position:absolute;right:0;bottom:0"><button style="font:20px/24px Arial;white-space:nowrap">Hello</button></div></div></section>');
    result = await probe({ selector: '.dl button', boundary: '.plate', source: 'Hello', corpus: 'W', ceiling: 30 });
    assert.equal(result.observations[0].reason, '下载按钮与配图重叠');
    await page.setContent('<div class="metarow" style="width:130px;position:relative;font:20px/24px Arial"><span style="position:absolute;left:0">01</span><span style="position:absolute;right:0;white-space:nowrap">Hello</span></div>');
    result = await probe({ selector: '.metarow span:last-child', boundary: '.metarow', source: 'Hello', corpus: 'W', ceiling: 20 });
    assert.equal(result.observations[0].reason, '元信息文字相互遮挡');
    await page.setContent('<header class="site-nav"><nav><div class="menu" style="position:fixed;inset:8px;overflow-y:auto"><div class="links" style="width:140px"><a style="display:block;white-space:normal;overflow-wrap:anywhere;font:20px/24px Arial">Hello</a><a style="display:block">Next</a></div></div></nav></header>');
    result = await probe({ selector: '.links > a:first-child', source: 'Hello', corpus: 'more text ', ceiling: 512 });
    assert.equal(result.observations[0].limit, undefined);
    assert.equal(result.observations[0].unresolved, undefined);
    assert.ok(result.observations[0].flowing.heightAfter > result.observations[0].flowing.heightBefore);
    result = await probe({ selector: '.links > a:first-child', source: 'Hello', corpus: 'more text ', ceiling: 1 });
    assert.equal(result.observations[0].unresolved, undefined, 'A short comparison ceiling does not have to grow a flowing navigation link.');
    assert.equal(result.observations[0].flowing, undefined);
    assert.equal(result.observations[0].testedThrough, 6);
    await page.setContent('<div class="x-frame" style="width:100px;overflow-x:clip"><section id="devices" class="decked"><article class="card" style="width:100px;transform:translateX(3000px)"><h3 style="font:20px/24px Arial;white-space:nowrap">Hello</h3></article></section></div>');
    result = await probe({ selector: '#devices h3', source: 'Hello', corpus: 'W', ceiling: 20 });
    assert.equal(result.observations[0].referenceFailure, null, 'A parked card outside x-frame is an intentional choreography state.');
    assert.equal(result.observations[0].reason, '设备文字超出卡片范围', 'Parked cards must still enforce their internal text boundary.');
    await page.setContent('<p style="transform:rotate(5deg)">Hello</p>');
    result = await probe({ selector: 'p', source: 'Hello', inspectOnly: true });
    assert.equal(result.observations[0].unresolved, true, 'Unknown geometry must remain an explicit measurement gap.');
    await page.setContent('<p style="display:none">Hidden</p>');
    assert.equal((await probe({ selector: 'p', source: 'Hidden' })).observed, 0);
    assert.equal((await probe({ selector: '.missing', source: 'Missing' })).observed, 0);
    console.log('[copy-layout-probe] defaults, ink, overflow, flowing, reference, paragraphs, faces, templates, collections and absent surfaces passed');
  } finally { await browser.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) await selfTest();
