/* M16 samples the rendered backdrop, including CSS veils, while retaining raw
   canvas activity/density checks. Text is hidden only for the screenshot. */
export function mobileHeroCopyIsClear(sample) {
  return sample?.canvasActive === true
    && sample.lineCount >= 3
    && sample.flightCount === 14
    && sample.dotCount === 2059
    && sample.shieldLineCount >= 3
    && sample.foregroundRatio >= 0.001
    && sample.visibleForegroundRatio >= 0.001
    && sample.worstBrightRatio <= 0.002
    && sample.peakLumaDelta <= 36;
}

export async function sampleMobileHeroCopy(page) {
  const state = await page.evaluateHandle(() => {
    // Freeze CSS geometry at the sampled phase; do not fast-forward the opening
    // animation as screenshot({ animations: 'disabled' }) would do.
    const animations = document.getAnimations().filter(animation => animation.playState === 'running');
    for (const animation of animations) animation.pause();
    const hidden = document.createElement('style');
    hidden.textContent = '.hero h1, .hero .sub, .hero .sub2 { visibility: hidden !important; }';
    document.head.append(hidden);
    return { animations, hidden };
  });
  try {
    const measurement = await page.evaluate(() => {
      const canvas = document.getElementById('x-bg');
      const ctx = canvas?.getContext('2d');
      const box = element => {
        const r = element.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const probe = document.createElement('span');
      probe.style.color = 'var(--x-bg)';
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [12, 12, 13];
      probe.remove();
      let foreground = 0;
      let fieldSamples = 0;
      if (ctx && canvas.width && canvas.height) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < canvas.height; y += 8) {
          for (let x = 0; x < canvas.width; x += 8) {
            const i = (y * canvas.width + x) * 4;
            if (Math.max(...rgb.map((value, channel) => Math.abs(data[i + channel] - value))) >= 12) foreground++;
            fieldSamples++;
          }
        }
      }
      const rects = [];
      for (const element of document.querySelectorAll('.hero h1, .hero .sub, .hero .sub2')) {
        const revealLines = [...element.querySelectorAll(':scope > .lr-line')];
        const lines = revealLines.length ? revealLines.map(line => {
          const inner = line.querySelector('.lr-inner');
          if (!inner) return line.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(inner);
          const ink = [...range.getClientRects()].filter(rect => rect.width > 0);
          return ink.length ? {
            left: Math.min(...ink.map(rect => rect.left)), right: Math.max(...ink.map(rect => rect.right)),
            top: Math.min(...ink.map(rect => rect.top)), bottom: Math.max(...ink.map(rect => rect.bottom)),
          } : line.getBoundingClientRect();
        }) : (() => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()];
        })();
        for (const r of lines) {
          if (r.right > r.left && r.bottom > r.top && r.bottom > 0 && r.top < innerHeight) {
            rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          }
        }
      }
      return {
        rgb, rects, width: innerWidth, height: innerHeight,
        hero: document.querySelector('.hero') ? box(document.querySelector('.hero')) : null,
        exclusions: [...document.querySelectorAll('.site-nav, #download')].map(box),
        canvasActive: !!ctx && Number(window.__xbg?.renders) > 2,
        flightCount: Number(window.__xbg?.fl) || 0,
        dotCount: Number(window.__xbg?.dots) || 0,
        shieldLineCount: Number(window.__xbg?.shieldLines) || 0,
        foregroundRatio: fieldSamples ? foreground / fieldSamples : 0,
      };
    });
    const png = await page.screenshot({ type: 'png', animations: 'allow', caret: 'initial' });
    return await page.evaluate(async ({ png, m }) => {
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const sx = canvas.width / m.width, sy = canvas.height / m.height;
      const bgLuma = 0.2126 * m.rgb[0] + 0.7152 * m.rgb[1] + 0.0722 * m.rgb[2];
      let lineCount = 0, worstBrightRatio = 0, peakLumaDelta = 0;
      for (const r of m.rects) {
        const x0 = Math.max(0, Math.floor(r.left * sx)), x1 = Math.min(canvas.width, Math.ceil(r.right * sx));
        const y0 = Math.max(0, Math.floor(r.top * sy)), y1 = Math.min(canvas.height, Math.ceil(r.bottom * sy));
        if (x1 <= x0 || y1 <= y0) continue;
        const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let bright = 0;
        for (let i = 0; i < data.length; i += 4) {
          const delta = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] - bgLuma;
          if (delta > 36) bright++;
          peakLumaDelta = Math.max(peakLumaDelta, delta);
        }
        lineCount++;
        worstBrightRatio = Math.max(worstBrightRatio, bright / (data.length / 4));
      }
      // A fully opaque veil must not pass by hiding the globe. Count only the
      // hero backdrop, excluding navigation/download UI that could fake activity.
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const inside = (r, x, y) => r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      let visible = 0, samples = 0;
      for (let y = 0; y < canvas.height; y += 8) {
        for (let x = 0; x < canvas.width; x += 8) {
          if (!inside(m.hero, x / sx, y / sy) || m.exclusions.some(r => inside(r, x / sx, y / sy))) continue;
          const i = (y * canvas.width + x) * 4;
          if (Math.max(...m.rgb.map((value, channel) => Math.abs(data[i + channel] - value))) >= 12) visible++;
          samples++;
        }
      }
      return {
        canvasActive: m.canvasActive, lineCount, flightCount: m.flightCount, dotCount: m.dotCount,
        shieldLineCount: m.shieldLineCount, foregroundRatio: m.foregroundRatio,
        visibleForegroundRatio: samples ? visible / samples : 0, worstBrightRatio, peakLumaDelta,
      };
    }, { png: png.toString('base64'), m: measurement });
  } finally {
    await state.evaluate(({ animations, hidden }) => {
      hidden.remove();
      for (const animation of animations) animation.play();
    });
    await state.dispose();
  }
}

export async function testMobileHeroSampling(chromium) {
  const browser = await chromium.launch();
  const cases = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await page.setContent(`<style>
      :root { --x-bg: rgb(12,12,13) } body { margin:0; background:var(--x-bg) }
      #x-bg { position:fixed; inset:0; width:390px; height:844px }
      .hero { position:relative; height:844px; padding:20px; box-sizing:border-box }
      .hero::before { content:''; position:absolute; inset:0; background:linear-gradient(rgb(12 12 13 / .96) 40%,transparent 65%) }
      .hero>* { position:relative; color:white; font:24px/1.5 sans-serif; margin:0 0 20px }
      .unshielded::before { display:none } .opaque::before { background:var(--x-bg) }
      h1 { animation: drift 60s linear infinite } @keyframes drift { to { transform:translateY(10px) } }
    </style><canvas id="x-bg" width="390" height="844"></canvas><section class="hero"><h1>Hero title</h1><p class="sub">Main message</p><p class="sub2">Supporting message</p></section>`);
    await page.evaluate(() => {
      const ctx = document.getElementById('x-bg').getContext('2d');
      ctx.fillStyle = 'rgb(12,12,13)'; ctx.fillRect(0, 0, 390, 844);
      ctx.fillStyle = 'rgb(158,220,29)'; ctx.fillRect(0, 0, 390, 300); ctx.fillRect(200, 600, 190, 200);
      window.__xbg = { renders: 3, fl: 14, dots: 2059, shieldLines: 3 };
    });
    const good = await sampleMobileHeroCopy(page);
    cases.push(['CSS 遮罩参与真实合成采样', mobileHeroCopyIsClear(good)]);
    cases.push(['采样后恢复文字与动画', await page.evaluate(() => getComputedStyle(document.querySelector('h1')).visibility === 'visible' && document.getAnimations().every(a => a.playState === 'running'))]);
    await page.locator('.hero').evaluate(el => el.classList.add('unshielded'));
    const bright = await sampleMobileHeroCopy(page);
    cases.push(['移除遮罩的真实亮轨被拒', !mobileHeroCopyIsClear(bright) && bright.peakLumaDelta > 36]);
    await page.locator('.hero').evaluate(el => { el.classList.remove('unshielded'); el.classList.add('opaque'); });
    const opaque = await sampleMobileHeroCopy(page);
    cases.push(['完全遮掉地球的伪修复被拒', !mobileHeroCopyIsClear(opaque) && opaque.foregroundRatio > 0.001 && opaque.visibleForegroundRatio === 0]);
    await page.locator('.hero').evaluate(el => el.classList.remove('opaque'));
    await page.evaluate(() => { document.getElementById('x-bg').getContext('2d').clearRect(0, 0, 390, 844); window.__xbg.renders = 0; });
    cases.push(['清空画布的伪修复被拒', !mobileHeroCopyIsClear(await sampleMobileHeroCopy(page))]);
  } finally {
    await browser.close();
  }
  return cases;
}
