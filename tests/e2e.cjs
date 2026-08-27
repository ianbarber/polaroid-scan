// End-to-end: drive the real app in headless Chromium with a fake camera fed by a y4m file.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const y4m = process.argv[2];
  const outDir = process.argv[3] || '.';
  const url = process.argv[4] || 'http://localhost:8000/';
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
      '--no-sandbox',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning') console.log(t); });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.click('#startBtn');
  const status = async () => page.$eval('#hint', e => e.textContent);
  // wait for border found
  let found = false;
  for (let i = 0; i < 60; i++) {
    const s = await status();
    if (/Border found/.test(s)) { found = true; break; }
    await page.waitForTimeout(250);
  }
  console.log('status before scan:', await status());
  const vdim = await page.$eval('#video', v => `${v.videoWidth}x${v.videoHeight}`);
  console.log('video', vdim, 'border found:', found);
  await page.screenshot({ path: path.join(outDir, 'e2e_live.png') });
  if (!found) { console.log('LOGS', logs.slice(-20).join('\n')); await browser.close(); process.exit(1); }
  await page.click('#captureBtn');
  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 240; i++) {
    const s = await status();
    if (i % 8 === 0) console.log(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);
    if (/^Done/.test(s) || /failed/i.test(s) || /No usable|Only 1/.test(s)) { done = true; console.log('final:', s); break; }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(outDir, 'e2e_result.png'), fullPage: true });
  const meta = await page.$eval('#metaText', e => e.textContent).catch(() => '');
  const diag = await page.$eval('#diagText', e => e.textContent).catch(() => '');
  console.log('meta:', meta); console.log('diag:', diag);
  // pull the result canvas
  const framedDims = await page.$eval('#resultCanvas', c => [c.width, c.height]);
  await page.click('#frameSeg button[data-v="image"]');
  await page.waitForTimeout(200);
  const imageDims = await page.$eval('#resultCanvas', c => [c.width, c.height]);
  await page.click('#frameSeg button[data-v="frame"]');
  await page.waitForTimeout(200);
  console.log('with frame:', framedDims.join('x'), `(ratio ${(framedDims[0] / framedDims[1]).toFixed(3)})`, '| image only:', imageDims.join('x'), `(ratio ${(imageDims[0] / imageDims[1]).toFixed(3)})`);
  const dataUrl = await page.evaluate(() => { const c = document.getElementById('resultCanvas'); return c && c.width ? c.toDataURL('image/png') : null; });
  if (dataUrl) { fs.writeFileSync(path.join(outDir, 'e2e_fused.png'), Buffer.from(dataUrl.split(',')[1], 'base64')); console.log('saved e2e_fused.png'); }
  // test Stop (cancel) behaviour: start a scan then cancel
  await page.click('#captureBtn');
  await page.waitForTimeout(1200);
  await page.click('#stopBtn');
  await page.waitForTimeout(300);
  console.log('after cancel:', await status(), '| capture btn:', await page.$eval('#captureBtn', e => e.textContent), '| stop btn:', await page.$eval('#stopBtn', e => e.textContent));
  await page.click('#stopBtn');
  await page.waitForTimeout(300);
  console.log('after stop camera:', await status(), '| start visible:', await page.$eval('#startBtn', e => !e.classList.contains('hidden')));
  const errs = logs.filter(l => l.startsWith('[error]'));
  console.log('console errors:', errs.length, errs.slice(0, 5).join('\n'));
  await browser.close();
})();
