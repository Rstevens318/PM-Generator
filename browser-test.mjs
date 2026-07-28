// browser-test.mjs — Playwright smoke test for BAS_PM_Generator
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 7788;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.pdf':  'application/pdf',
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const filePath = join(__dirname, decodeURIComponent(url));
  if (!existsSync(filePath) || filePath === __dirname + '/') {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Server at http://127.0.0.1:${PORT}`);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[browser error] ${msg.text().slice(0, 120)}`);
    else if (/extract|detect|Functional|Parser|dedup/i.test(msg.text())) console.log(`[browser] ${msg.text().slice(0, 120)}`);
  });

  // Intercept CDN requests → serve local libs
  await page.route('**/pdf.js/3.11.174/pdf.min.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(__dirname, 'libs/pdfjs/pdf.min.js')) }));
  await page.route('**/pdf.js/3.11.174/pdf.worker.min.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(__dirname, 'libs/pdfjs/pdf.worker.min.js')) }));
  // Stub out compromise and transformers (not needed for parser test)
  await page.route('**/compromise**', r =>
    r.fulfill({ contentType: 'application/javascript', body: 'window.nlp = null;' }));
  await page.route('**/transformers**', r =>
    r.fulfill({ contentType: 'application/javascript', body: '' }));

  await page.goto(`http://127.0.0.1:${PORT}/BAS_PM_Generator_v10.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const pdfPath = join(__dirname, 'B204_AHU-S1-6 SoO_Rev9.pdf');
  console.log(`\nUploading: ${pdfPath}`);

  // Upload PDF — this triggers info-form to appear
  await page.locator('#i-soo').setInputFiles(pdfPath);
  // Wait for info-form to become visible
  await page.waitForSelector('#info-form', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(300);

  // Fill in building/unit info
  await page.fill('#building', '204');
  await page.fill('#unit-id', 'AHU-S1');
  await page.fill('#tech-name', 'Test Tech');

  await page.screenshot({ path: '/tmp/01-uploaded.png' });
  console.log('Screenshot saved: /tmp/01-uploaded.png');

  // Generate
  await page.click('#btn-gen');
  console.log('Clicked Generate — waiting for output...');

  try {
    await page.waitForSelector('#output', { state: 'visible', timeout: 45000 });
    await page.waitForTimeout(1000);
  } catch {
    await page.screenshot({ path: '/tmp/02-timeout.png', fullPage: true });
    console.error('TIMEOUT — screenshot at /tmp/02-timeout.png');
    await browser.close(); server.close(); process.exit(1);
  }

  await page.screenshot({ path: '/tmp/02-result-top.png' });
  console.log('Screenshot saved: /tmp/02-result-top.png');

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/03-result-mid.png' });

  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/04-result-bottom.png' });
  console.log('Screenshots saved: /tmp/03-result-mid.png, /tmp/04-result-bottom.png');

  // Stats
  const sectionCount = await page.locator('.section').count();
  const cbCount      = await page.locator('.cb').count();
  const subsections  = await page.locator('.subsec-title').allTextContents();
  const checks       = await page.locator('.item .item-text').allTextContents();

  console.log(`\n=== Result: ${sectionCount} sections, ${cbCount} checkboxes ===`);
  if (subsections.length) {
    console.log('\nFunctional subsections:');
    subsections.forEach(s => console.log(`  • ${s.trim()}`));
  }
  console.log('\nFirst 15 check items:');
  checks.slice(0, 15).forEach((t, i) => console.log(`  ${i+1}. ${t.trim().slice(0, 90)}`));

  await browser.close();
  server.close();
  console.log('\nDone.');
});
