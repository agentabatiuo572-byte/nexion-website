// Node 24+: node --test scripts/download-distribution.test.mjs
// Requirements-based policy tests; the browser suite tests the emitted site separately.
import assert from 'node:assert/strict';
import test from 'node:test';
import '../worker/register-ts-ext.mjs';
import { decideDownload, detectDevice, distributionPath, isEmbeddedBrowser,
  parseDownloadRequest, safeDownloadUrl } from '../src/lib/distribution.ts';
const { resolveDownloadUrl } = await import('../src/lib/download-policy.ts');

const urls = Object.freeze({ ios: 'https://downloads.example.test/ios',
  android: 'https://downloads.example.test/android.apk', h5: 'https://downloads.example.test/h5' });
const empty = Object.freeze({ ios: '', android: '', h5: '' });

test('device detection uses OS evidence, including desktop-mode iPad; unknown mobile stays unknown', () => {
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile', 'iPhone', 5, 'ios'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad', 5, 'ios'],
    ['Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', 'iPod', 5, 'ios'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15', 'MacIntel', 5, 'ios'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15', 'MacIntel', 0, 'desktop'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', 'Linux armv8l', 5, 'android'],
    ['Mozilla/5.0 (Linux; Android 15; Tablet) Chrome/130', 'Linux armv8l', 5, 'android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0, 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10, 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64', 0, 'desktop'],
    ['Mozilla/5.0 (X11; CrOS x86_64 16000)', 'Linux x86_64', 0, 'desktop'],
    ['Mozilla/5.0 (Windows Phone 10.0; Android 6.0) Mobile', 'Win32', 5, 'unknown'],
    ['Mozilla/5.0 (HarmonyOS 5.0) Mobile', '', 5, 'unknown'],
    ['Unrecognized Mobile/1.0', '', 5, 'unknown'],
    ['', '', 0, 'unknown'],
  ];
  for (const [ua, platform, touch, expected] of cases) assert.equal(detectDevice(ua, platform, touch), expected, ua);
});

test('common embedded browsers are detected without blocking normal Chrome or Safari', () => {
  for (const marker of ['MicroMessenger/8.0', 'QQ/9.0', 'Weibo', 'FBAN/FBIOS', 'FBAV/400', 'Instagram', 'DingTalk']) {
    assert.equal(isEmbeddedBrowser(`Mozilla/5.0 ${marker}`), true, marker);
  }
  for (const marker of ['Chrome/130.0 Mobile Safari/537.36', 'Version/18.0 Mobile Safari/604.1', 'MQQBrowser/15.1']) {
    assert.equal(isEmbeddedBrowser(`Mozilla/5.0 ${marker}`), false, marker);
  }
});

test('request parser is a closed platform allowlist; unsupported query data means auto', () => {
  for (const platform of ['ios', 'android', 'h5']) assert.equal(parseDownloadRequest(platform), platform);
  for (const value of [null, undefined, '', 'auto', 'IOS', 'android&url=https://evil.test', 'https://evil.test', 'javascript:alert(1)']) {
    assert.equal(parseDownloadRequest(value), 'auto', String(value));
  }
});

test('only HTTPS without credentials or local absolute paths are accepted destinations', () => {
  for (const [input, expected] of [[' https://downloads.example.test/app.apk ', urls.android.replace('android.apk', 'app.apk')],
    ['/downloads/app.apk?version=2', '/downloads/app.apk?version=2'], ['https://downloads.example.test', 'https://downloads.example.test/']]) {
    assert.equal(safeDownloadUrl(input), expected);
  }
  for (const input of [undefined, '', '   ', '//evil.test/app', 'http://evil.test', 'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'file:///tmp/app.apk', 'intent://app', 'ftp://evil.test/app',
    'https://user:password@downloads.example.test/app', 'https://user@downloads.example.test/app',
    'https://downloads.example.test/a\nb', '/\\evil.test/app', '\\evil.test', '/bad\u0000name', 'relative/app.apk']) {
    assert.equal(safeDownloadUrl(input), '', String(input));
  }
});

test('disabled configuration wins over both saved destinations and environment fallback', () => {
  for (const platform of ['ios', 'android', 'h5']) {
    assert.equal(resolveDownloadUrl({ enabled: false, url: urls[platform] }, urls[platform]), '');
    assert.equal(resolveDownloadUrl({ enabled: false, url: '' }, urls[platform]), '');
    assert.equal(resolveDownloadUrl({ enabled: true, url: urls[platform] }, 'https://other.example.test'), urls[platform]);
    assert.equal(resolveDownloadUrl({ enabled: true, url: '  ' }, urls[platform]), urls[platform]);
    assert.equal(resolveDownloadUrl({ enabled: true, url: '' }, undefined), '');
    assert.equal(resolveDownloadUrl({ enabled: true, url: 'javascript:alert(1)' }, urls[platform]), '');
  }
});

test('desktop App entries use QR even when narrow; the web app navigates directly', () => {
  for (const source of ['button', 'scan']) for (const platform of ['ios', 'android']) {
    assert.deepEqual(decideDownload(platform, 'desktop', urls, false, source), { kind: 'qr', platform, url: urls[platform] });
    assert.deepEqual(decideDownload(platform, 'desktop', empty, false, source), { kind: 'qr', platform, url: '' });
  }
  assert.deepEqual(decideDownload('h5', 'desktop', urls, false), { kind: 'navigate', platform: 'h5', url: urls.h5 });
});

test('every phone App button follows the actual phone OS', () => {
  for (const device of ['ios', 'android']) for (const request of ['ios', 'android', 'auto']) {
    assert.deepEqual(decideDownload(request, device, urls, false, 'button'), { kind: 'navigate', platform: device, url: urls[device] });
    assert.deepEqual(decideDownload(request, device, empty, false, 'button'), { kind: 'unavailable', platform: device, url: '' });
  }
});

test('explicit scanned platform mismatch requires correction; auto scan uses the actual OS', () => {
  for (const device of ['ios', 'android']) {
    const opposite = device === 'ios' ? 'android' : 'ios';
    assert.deepEqual(decideDownload(opposite, device, urls, false, 'scan'), { kind: 'mismatch', platform: opposite, url: '' });
    assert.deepEqual(decideDownload(opposite, device, urls, true, 'scan'), { kind: 'mismatch', platform: opposite, url: '' });
    assert.deepEqual(decideDownload('auto', device, urls, false, 'scan'), { kind: 'navigate', platform: device, url: urls[device] });
    assert.deepEqual(decideDownload(device, device, urls, false, 'scan'), { kind: 'navigate', platform: device, url: urls[device] });
  }
});

test('unknown auto device offers a choice; explicit manual selection remains usable', () => {
  for (const source of ['button', 'scan']) {
    assert.equal(decideDownload('auto', 'unknown', urls, false, source).kind, 'choose');
    for (const platform of ['ios', 'android']) assert.deepEqual(decideDownload(platform, 'unknown', urls, false, source), {
      kind: 'navigate', platform, url: urls[platform],
    });
  }
});

test('web app works on every OS and embedded browsers provide browser guidance', () => {
  for (const device of ['ios', 'android', 'desktop', 'unknown']) for (const source of ['button', 'scan']) {
    assert.deepEqual(decideDownload('h5', device, urls, false, source), { kind: 'navigate', platform: 'h5', url: urls.h5 });
    assert.deepEqual(decideDownload('h5', device, urls, true, source), { kind: 'browser', platform: 'h5', url: urls.h5 });
    assert.deepEqual(decideDownload('h5', device, empty, true, source), { kind: 'unavailable', platform: 'h5', url: '' });
  }
  for (const device of ['ios', 'android']) assert.deepEqual(decideDownload(device, device, urls, true, 'scan'), {
    kind: 'browser', platform: device, url: urls[device],
  });
});

test('unsafe configured links never become navigable decisions', () => {
  for (const unsafe of ['javascript:alert(1)', '//evil.test', 'https://user@evil.test', 'http://evil.test']) {
    const invalid = { ios: unsafe, android: unsafe, h5: unsafe };
    for (const platform of ['ios', 'android', 'h5']) assert.equal(decideDownload(platform, 'unknown', invalid, false, 'scan').kind, 'unavailable');
  }
});

test('distribution links use the localized local route with a platform hint only', () => {
  assert.equal(distributionPath('en'), '/download/?platform=auto');
  assert.equal(distributionPath('en', 'ios'), '/download/?platform=ios');
  assert.equal(distributionPath('vi', 'android'), '/vi/download/?platform=android');
  assert.equal(distributionPath('zh', 'h5'), '/zh/download/?platform=h5');
});
