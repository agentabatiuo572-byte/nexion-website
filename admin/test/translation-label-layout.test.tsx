// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ data: { states: [] as Record<string, unknown>[] } }));
vi.mock('../src/lib/translations', () => ({ useTranslations: () => mocks, translationError: () => '未完成' }));
import { TranslatedTextarea } from '../src/lib/translated-textarea';

afterEach(cleanup);

it('aligns every translation status with its action without inheriting stacked helper spacing', async () => {
  const cases = [
    { id: 'seed', value: 'Saved', origin: 'seed' },
    { id: 'manual', value: 'Saved', origin: 'manual' },
    { id: 'ai', value: 'Saved', origin: 'ai' },
    { id: 'missing', value: '', origin: 'none' },
    { id: 'edited', value: 'Changed', origin: 'seed' },
  ];
  mocks.data.states = cases.map(item => ({ draftFieldId: item.id, targetValue: 'Saved', origin: item.origin }));
  const { container } = render(<main>{cases.map(item => <div className="field" key={item.id}>
    <TranslatedTextarea id={item.id} label="英语" draftFieldId={item.id} targetLocale="en" source="原文" value={item.value} onValueChange={() => {}} />
  </div>)}<div className="card" id="stacked-control"><p className="kv">说明</p><button className="btn">后续操作</button></div></main>);
  expect(screen.getByText('默认译文')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'AI 翻译' })).toHaveLength(cases.length);
  const repo = existsSync(resolve(process.cwd(), 'admin/package.json')) ? process.cwd() : resolve(process.cwd(), '..');
  const { chromium } = createRequire(resolve(repo, 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>' + readFileSync(resolve(repo, 'admin/src/styles.css'), 'utf8') + '</style>' + container.innerHTML);
    for (const width of [320, 390, 760, 1024, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const fontSize of [16, 20]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = size + 'px'; }, fontSize);
        const measured = await page.evaluate(() => ({
          rows: Array.from(document.querySelectorAll('.translation-input-label')).map(row => {
            const children = Array.from(row.children), boxes = children.map(el => el.getBoundingClientRect());
            const button = row.querySelector('.btn')!, buttonBox = button.getBoundingClientRect();
            return { centers: boxes.map(box => box.top + box.height / 2), marginTop: getComputedStyle(button).marginTop,
              buttonHeight: buttonBox.height, overflow: row.scrollWidth > row.clientWidth };
          }),
          stackedMargin: parseFloat(getComputedStyle(document.querySelector('#stacked-control .btn')!).marginTop),
        }));
        expect(measured.rows).toHaveLength(cases.length);
        for (const row of measured.rows) {
          expect(Math.max(...row.centers) - Math.min(...row.centers)).toBeLessThanOrEqual(1);
          expect(row.marginTop).toBe('0px');
          expect(row.buttonHeight).toBeGreaterThanOrEqual(44);
          expect(row.overflow).toBe(false);
        }
        expect(measured.stackedMargin).toBeGreaterThan(0);
      }
    }
  } finally { await browser.close(); }
}, 20000);

it('balances real page descriptions so a final Chinese character or punctuation does not sit alone', async () => {
  const repo = existsSync(resolve(process.cwd(), 'admin/package.json')) ? process.cwd() : resolve(process.cwd(), '..');
  const pages = resolve(repo, 'admin/src/pages');
  const descriptions = readdirSync(pages).filter(name => name.endsWith('.tsx')).flatMap(name =>
    [...readFileSync(resolve(pages, name), 'utf8').matchAll(/className="page-description">([^<{]+)<\/p>/g)].map(match => ({ name, text: match[1]! })));
  expect(descriptions.some(item => item.name === 'languages.tsx')).toBe(true);
  expect(descriptions.length).toBeGreaterThanOrEqual(8);
  const { chromium } = createRequire(resolve(repo, 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.setContent('<style>' + readFileSync(resolve(repo, 'admin/src/styles.css'), 'utf8') + '</style><main></main>');
    const results = await page.evaluate(items => {
      const host = document.querySelector('main')!;
      const failures: unknown[] = [];
      let checked = 0, originalOrphans = 0;
      const linesOf = (el: Element) => {
        const text = el.firstChild!, lines = new Map<number, string>();
        for (let index = 0; index < text.textContent!.length; index++) {
          const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
          const top = Math.round(range.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? '') + text.textContent![index]);
        }
        return [...lines.values()].map(line => line.trim());
      };
      for (const item of items) {
        const paragraph = document.createElement('p'); paragraph.className = 'page-description'; paragraph.textContent = item.text;
        host.replaceChildren(paragraph);
        for (const size of [16, 20, 24]) {
          document.documentElement.style.fontSize = size + 'px';
          for (let width = 248; width <= 1200; width += 16) {
            host.style.width = width + 'px';
            paragraph.style.textWrap = 'wrap';
            const original = linesOf(paragraph);
            if (original.length > 1 && original.at(-1)!.replace(/[。；，、！：？「」“”\s]/g, '').length < 2) originalOrphans++;
            paragraph.style.removeProperty('text-wrap');
            const actual = linesOf(paragraph); checked++;
            if (actual.length > 1 && actual.at(-1)!.replace(/[。；，、！：？「」“”\s]/g, '').length < 2) failures.push({ page: item.name, size, width, actual });
            if (paragraph.scrollWidth > paragraph.clientWidth) failures.push({ page: item.name, size, width, overflow: true });
          }
        }
      }
      return { checked, originalOrphans, failures };
    }, descriptions);
    expect(results.originalOrphans).toBeGreaterThan(0);
    expect(results.checked).toBeGreaterThan(1000);
    expect(results.failures).toEqual([]);
  } finally { await browser.close(); }
}, 30000);
