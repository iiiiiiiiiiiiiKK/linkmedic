#!/usr/bin/env node
/**
 * Capture the documentation screenshots from a *running* LinkMedic instance.
 *
 *   BASE_URL=https://linkmedic.pages.dev node scripts/capture-screenshots.mjs
 *
 * Output: docs/screenshots/*.png (light + dark, desktop + iPhone).
 * These are real captures of the deployed app — never mockups.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const TARGET = process.env.SHOT_URL ?? 'https://github.com';

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((candidate) => existsSync(candidate));

if (!CHROME) throw new Error('No Chromium binary found.');

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function shot(name, options) {
  const context = await browser.newContext({
    viewport: options.viewport,
    colorScheme: options.scheme,
    locale: 'zh-CN',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  if (options.run) {
    await page.fill('#url-input', options.target ?? TARGET);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.score__value', { timeout: 90_000 });
    await page.waitForTimeout(600);
  }
  if (options.expandFinding) {
    const head = page.locator('.finding__head').first();
    if ((await head.count()) > 0) {
      await head.click();
      await page.waitForTimeout(200);
    }
  }
  if (options.scrollTo) {
    await page.evaluate((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: 'start' });
    }, options.scrollTo);
    await page.waitForTimeout(250);
  }

  await page.screenshot({ path: join(OUT, name), fullPage: options.fullPage ?? false });
  await context.close();
  console.log('captured', name);
}

await shot('01-desktop-idle-dark.png', { viewport: { width: 1280, height: 860 }, scheme: 'dark' });
await shot('02-desktop-report-dark.png', {
  viewport: { width: 1280, height: 1240 },
  scheme: 'dark',
  run: true,
  target: TARGET,
  scrollTo: '.result',
});
await shot('03-desktop-report-light.png', {
  viewport: { width: 1280, height: 1240 },
  scheme: 'light',
  run: true,
  target: TARGET,
  scrollTo: '.result',
});
await shot('04-desktop-evidence.png', {
  viewport: { width: 1280, height: 1000 },
  scheme: 'dark',
  run: true,
  target: TARGET,
  expandFinding: true,
  scrollTo: '.findings',
});
await shot('05-desktop-blocked.png', {
  viewport: { width: 1280, height: 900 },
  scheme: 'dark',
  run: true,
  target: 'http://169.254.169.254/latest/meta-data/',
  scrollTo: '.result',
});
await shot('06-iphone-idle.png', {
  viewport: { width: 390, height: 844 },
  scheme: 'dark',
});
await shot('07-iphone-report.png', {
  viewport: { width: 390, height: 844 },
  scheme: 'light',
  run: true,
  target: TARGET,
  scrollTo: '.score',
});

await browser.close();
console.log(`\nScreenshots written to ${OUT}`);
