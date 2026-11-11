import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { validateTranslationValue } from '../schema/src/draft-fields.ts';
import { validateTranslationText } from '../worker/src/ai-client.ts';
const root = new URL('../', import.meta.url);
const json = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));

test('all nine dictionaries and the materialized seed use the current company', () => {
  const seed = json('worker/seed/site-config.seed.json');
  for (const locale of ['en','vi','zh','es','pt','fr','de','ja','ko']) {
    const dict = json(`src/i18n/${locale}.json`);
    assert.match(dict.trust.t1Title, /UVEL AI LTD/);
    assert.equal(dict.trust.t1Chip, 'DOS ID 8040896');
    assert.equal(dict.trust.t2Chip, 'MSB 31000342955895');
    assert.match(dict.footer.legalLine, /UVEL AI LTD/);
    for (const key of ['t1Title','t1Body','t1Chip','t1Cta','t2Title','t2Chip']) {
      assert.equal(seed.copy[locale][`trust.${key}`], dict.trust[key]);
    }
  }
  assert.equal(seed.footer.contactEmail, 'service@uvel.ai');
  assert.equal(json('src/config/site.json').footer.contactEmail, 'service@uvel.ai');
});

test('translation rejects old or altered legal names, including uppercase source copy', () => {
  const source = 'UVEL AI LTD 于纽约州注册成立。';
  assert.equal(validateTranslationValue({source,maxLength:200}, 'NexGrid LTD is incorporated in New York.'), 'stale-brand');
  assert.doesNotThrow(() => validateTranslationText(source, 'en', 'UVEL AI LTD is incorporated in New York.'));
  assert.throws(() => validateTranslationText(source, 'en', 'Uvel is incorporated in New York.'), /invalid-result/);
  assert.throws(() => validateTranslationText(source, 'en', 'UVEL AI INC is incorporated in New York.'), /invalid-result/);
});

test('only the reviewed English whitepaper is in the public deployment directory', () => {
  assert.deepEqual(readdirSync(new URL('public/documents/', root)).filter(f => /whitepaper/i.test(f)), ['uvel-whitepaper-v1.3-en.pdf']);
  assert(existsSync(new URL('docs/whitepapers/uvel-whitepaper-v1.2-zh.pdf', root)));
  const chineseSha = createHash('sha256').update(readFileSync(new URL('docs/whitepapers/uvel-whitepaper-v1.2-zh.pdf', root))).digest('hex');
  assert.equal(chineseSha, '2aa8b29fef961bab83acab47199301594aa06b0b7f1acfde5f2f1bef756397b8');
  const sha = createHash('sha256').update(readFileSync(new URL('public/documents/uvel-whitepaper-v1.3-en.pdf', root))).digest('hex');
  assert.equal(sha, '03ba647070e2e7d593023b5328504a5ccd193b258943565b380a888823119549');
  for (const name of ['cert-new-york.png','cert-new-york@2x.png','cert-msb.png','cert-msb@2x.png']) assert(existsSync(new URL(`public/${name}`, root)));
  assert(!existsSync(new URL('public/cert-colorado.png', root)));
});
