#!/usr/bin/env node
/* read-jsonc 的红绿两向自检。
   前四条是**旧正则实现会失败的原样标本**——它们在这里,是为了让那个实现回不来。 */
import { stripJsonc, parseJsonc } from './read-jsonc.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const say = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };
const eq = (a, b, msg) => say(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  实得 ${JSON.stringify(a)} 期望 ${JSON.stringify(b)}`}`);

// ① 行尾注释:旧实现只认独占一行的 //,这一条会让它当场崩
eq(parseJsonc('{"a": 1, // 说明\n "b": 2}'), { a: 1, b: 2 }, '行尾 // 注释被剥掉');

// ② URL 里的 //:旧实现的行注释正则不误伤(它要求行首),但块注释正则会
eq(parseJsonc('{"u": "https://a.example/x"}'), { u: 'https://a.example/x' }, '字符串里的 // 原样保留');

// ③ 字符串里的 /* */:旧实现会把它连同中间的内容一起吃掉
eq(parseJsonc('{"g": "a/*b*/c", "n": 1}'), { g: 'a/*b*/c', n: 1 }, '字符串里的 /* */ 原样保留');

// ④ 转义引号后面的内容不能被当成脱离字符串
eq(parseJsonc('{"s": "he said \\"//not a comment\\"", "n": 2}'), { s: 'he said "//not a comment"', n: 2 }, '转义引号内的 // 原样保留');

// ⑤ 块注释(独占多行)
eq(parseJsonc('{\n/* 说明\n   续行 */\n"a": 1}'), { a: 1 }, '多行块注释被剥掉');

// ⑥ 尾随逗号(JSONC 允许,JSON.parse 不允许)
eq(parseJsonc('{"a": [1, 2,], "b": 3,}'), { a: [1, 2], b: 3 }, '尾随逗号被剥掉');

// ⑦ 尾随逗号的剥除不能误伤字符串里的逗号
eq(parseJsonc('{"a": "x,", "b": ["y,",]}'), { a: 'x,', b: ['y,'] }, '字符串里的逗号不被误删');

// ⑧ 剥注释后行号不变(报错定位要能对上原文)
{
  const src = '{\n// 注释一\n/* 块\n   注释 */\n"a": 1\n}';
  const lines = (s) => s.split('\n').length;
  say(lines(stripJsonc(src)) === lines(src), `剥完注释行数不变(${lines(stripJsonc(src))} vs ${lines(src)})`);
}

// ⑨ 真的 wrangler.jsonc 读得动,且拿得到本门依赖的字段
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cfg = parseJsonc(readFileSync(path.join(here, '..', 'wrangler.jsonc'), 'utf8'), 'wrangler.jsonc');
  say(!!cfg.assets?.directory, `真 wrangler.jsonc 解析出 assets.directory = ${cfg.assets?.directory}`);
  say(Array.isArray(cfg.triggers?.crons) || cfg.triggers === undefined, 'triggers.crons 形状正常');
}

// ⑩ 坏输入必须抛,且报错里带得出出错位置附近的原文(不许静默返回 undefined)
{
  let threw = false;
  let msg = '';
  try { parseJsonc('{"a": }', 'fixture'); } catch (e) { threw = true; msg = String(e); }
  say(threw && /fixture 解析失败/.test(msg), `坏 JSONC 抛错且点名来源(${msg.slice(0, 60)}…)`);
}

process.exit(fails ? 1 : 0);
