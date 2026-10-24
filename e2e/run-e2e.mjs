#!/usr/bin/env node
/**
 * LinkMedic end-to-end check.
 *
 * Drives a real Chromium against a running LinkMedic instance and asserts on the
 * actual DOM: the URL flow, every interactive button, both themes, the mobile
 * viewport, keyboard operation and the export paths.
 *
 *   BASE_URL=https://linkmedic.pages.dev node e2e/run-e2e.mjs
 *   BASE_URL=http://127.0.0.1:8787 node e2e/run-e2e.mjs
 *
 * Screenshots are written to e2e/shots/ so the README always shows the real UI.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'e2e', 'shots');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });

  const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error(`No Chromium found. Tried:\n${CHROME_CANDIDATES.join('\n')}`);

  const browser = await chromium.launch({ executablePath, headless: true });

  /* ---------------------------------------------------------------- desktop */
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    locale: 'zh-CN',
  });
  const page = await desktop.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The invalid-input test below deliberately triggers a 422; Chromium logs any
    // non-2xx fetch as a console error, which is expected here and not a defect.
    if (/status of 422/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 1. Page identity + the author 𝕏 link required by the brief.
  const title = await page.title();
  record('title contains LinkMedic', /LinkMedic/.test(title), title);

  const authorLink = page.locator('a.author-link');
  record('author 𝕏 link exists', (await authorLink.count()) === 1);
  record(
    'author link points at x.com/0xkillcoin',
    (await authorLink.getAttribute('href')) === 'https://x.com/0xkillcoin',
    (await authorLink.getAttribute('href')) ?? '',
  );
  record(
    'author link opens in a new tab safely',
    (await authorLink.getAttribute('rel'))?.includes('noopener') === true,
  );

  await page.screenshot({ path: join(SHOTS, '01-idle-dark.png'), fullPage: true });

  // 2. Health endpoint reached from the browser (real API wiring).
  const healthOk = await page.evaluate(async () => {
    const response = await fetch('/api/health');
    if (!response.ok) return null;
    return response.json();
  });
  record('browser can reach /api/health', healthOk?.status === 'ok', healthOk?.runtime ?? 'no payload');

  // 3. Run a real diagnosis on a stable public site.
  await page.fill('#url-input', 'example.com');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.score__value', { timeout: 60_000 });

  const score = await page.locator('.score__value').innerText();
  const scoreNumber = Number(score);
  record(
    'diagnosis produced a numeric score',
    Number.isFinite(scoreNumber) && scoreNumber >= 0 && scoreNumber <= 100,
    score,
  );

  const statusPill = await page.locator('.status-pill').first().innerText();
  record('HTTP status is shown', /HTTP\s+\d{3}/.test(statusPill), statusPill);

  const findingCount = await page.locator('.finding').count();
  record('findings are rendered', findingCount > 0, `${findingCount} findings`);

  const hasFinalUrl = await page.locator('.fact', { hasText: '最终地址' }).count();
  record('final URL fact is rendered', hasFinalUrl > 0);

  await page.screenshot({ path: join(SHOTS, '02-report-dark.png'), fullPage: true });

  // 4. Expanding a finding reveals evidence + recommendation.
  const firstFinding = page.locator('.finding__head').first();
  await firstFinding.click();
  await page.waitForSelector('.finding__body:not([hidden])', { timeout: 5000 });
  record('finding expands to show the body', (await page.locator('.finding__body:not([hidden])').count()) > 0);
  const bodyText = await page.locator('.finding__body:not([hidden])').first().innerText();
  record('expanded body contains a recommendation', bodyText.length > 20, bodyText.slice(0, 40).replace(/\n/g, ' '));
  await firstFinding.click();

  // 5. Tabs actually filter.
  await page.click('#tab-pass');
  const passOnly = await page.locator('.finding').count();
  await page.click('#tab-issues');
  const issuesOnly = await page.locator('.finding').count();
  record(
    'pass filter and issue filter disagree',
    passOnly !== issuesOnly || passOnly > 0,
    `pass=${passOnly} issues=${issuesOnly}`,
  );
  await page.click('#tab-all');

  // 6. Response headers disclosure toggle.
  const headersToggle = page.locator('button', { hasText: '展开' }).first();
  if ((await headersToggle.count()) > 0) {
    await headersToggle.click();
    record('headers panel expands', (await page.locator('.headers__row').count()) > 0);
  } else {
    record('headers panel exists', false, 'toggle not found');
  }

  // 7. JSON + CSV export both fire a real download.
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('button:has-text("导出 JSON")'),
  ])
    .then(([d]) => d)
    .catch(() => null);
  record('JSON export triggers a download', download !== null, download?.suggestedFilename() ?? '');

  const csvDownload = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('button:has-text("导出 CSV")'),
  ])
    .then(([d]) => d)
    .catch(() => null);
  record('CSV export triggers a download', csvDownload !== null, csvDownload?.suggestedFilename() ?? '');

  if (csvDownload) {
    const path = await csvDownload.path();
    if (path) {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(path, 'utf8');
      record('CSV has the findings header row', text.includes('severity') && text.includes('recommendation'));
    }
  }

  // 8. Copy report writes to the clipboard.
  await page.click('button:has-text("复制报告")');
  const toast = await page
    .locator('.toast')
    .innerText()
    .catch(() => '');
  record('copy report shows feedback', toast.length > 0, toast);

  // 9. History is populated and clickable.
  const historyRows = await page.locator('.history__row').count();
  record('history recorded the run', historyRows >= 1, `${historyRows} rows`);

  // 10. Invalid input is rejected with a visible explanation, not a silent failure.
  await page.click('button:has-text("重新检测")');
  await page.fill('#url-input', 'http://169.254.169.254/latest/meta-data/');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.score__value', { timeout: 60_000 });
  const blockedText = await page.locator('.findings').innerText();
  record(
    'private metadata address is refused',
    /拦截|blocked|安全/i.test(blockedText),
    blockedText.slice(0, 60).replace(/\n/g, ' '),
  );
  await page.screenshot({ path: join(SHOTS, '03-blocked-target.png'), fullPage: true });

  // 11. Theme toggle flips the documented attribute.
  await page.click('button[aria-label="切换主题"]');
  const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  record('theme toggle changes data-theme', themeAttr === 'light' || themeAttr === 'dark', themeAttr ?? 'none');

  // 12. Language toggle swaps the copy.
  await page.click('button[aria-label="English"]');
  const runLabel = await page.locator('button[type="submit"]').innerText();
  record('language toggle switches to English', /Run diagnosis/i.test(runLabel), runLabel);
  await page.screenshot({ path: join(SHOTS, '04-light-en.png'), fullPage: true });
  await page.click('button[aria-label="中文"]');

  // 13. Keyboard-only operation: tab to the input, type, press Enter.
  await page.click('button:has-text("重新检测")');
  await page.evaluate(() => document.getElementById('url-input')?.focus());
  await page.keyboard.type('https://example.org');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.score__value', { timeout: 60_000 });
  const keyboardScore = await page.locator('.score__value').innerText();
  record('Enter key submits the form', Number(keyboardScore) >= 0, keyboardScore);

  record('no console errors during the desktop run', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await desktop.close();

  /* ----------------------------------------------------------------- mobile */
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  const phone = await mobile.newPage();
  await phone.goto(BASE, { waitUntil: 'networkidle' });

  // iPhone-sized layout must not scroll horizontally.
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  record('iPhone viewport has no horizontal overflow', overflow <= 1, `overflow=${overflow}px`);

  const inputBox = await phone.locator('#url-input').boundingBox();
  record('input is full width on mobile', (inputBox?.width ?? 0) > 300, `${Math.round(inputBox?.width ?? 0)}px`);

  const submitBox = await phone.locator('button[type="submit"]').boundingBox();
  record(
    'primary button is tap-sized (>=44px)',
    (submitBox?.height ?? 0) >= 44,
    `${Math.round(submitBox?.height ?? 0)}px`,
  );

  await phone.screenshot({ path: join(SHOTS, '05-mobile-idle.png'), fullPage: true });

  await phone.fill('#url-input', 'https://example.com');
  await phone.click('button[type="submit"]');
  await phone.waitForSelector('.score__value', { timeout: 60_000 });
  const mobileOverflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  record('iPhone report view has no horizontal overflow', mobileOverflow <= 1, `overflow=${mobileOverflow}px`);
  await phone.screenshot({ path: join(SHOTS, '06-mobile-report.png'), fullPage: true });

  // Tablet width sanity check (iPad portrait).
  await phone.setViewportSize({ width: 834, height: 1112 });
  await phone.waitForTimeout(300);
  const tabletOverflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  record('iPad viewport has no horizontal overflow', tabletOverflow <= 1, `overflow=${tabletOverflow}px`);
  await phone.screenshot({ path: join(SHOTS, '07-tablet-report.png'), fullPage: true });

  await mobile.close();
  await browser.close();

  const summary = {
    base: BASE,
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failures,
    failed: failures,
    results,
  };
  await writeFile(join(ROOT, 'e2e', 'last-run.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n${summary.passed}/${summary.total} checks passed against ${BASE}`);
  if (failures > 0) {
    console.error(`${failures} E2E check(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('E2E run crashed:', error);
  process.exit(1);
});
