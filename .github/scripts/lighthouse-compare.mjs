// Runs Lighthouse (mobile) on the live theme and a PR's preview theme, then fails if the preview
// is meaningfully slower or heavier than live. Both themes are audited in the same run, on the same
// machine, against the same store content, so the PR's code is the only real difference.
//
// Writes to OUTPUT_DIR: summary.md (the PR comment), results.json, and one HTML report per page and
// theme (the median run). Sets the `result` step output to pass or fail.
//
// Run by .github/workflows/pr-preview.yml. Needs lighthouse and puppeteer installed.

import fs from 'node:fs';
import path from 'node:path';
import lighthouse from 'lighthouse';
import { screenEmulationMetrics, userAgents } from 'lighthouse/core/config/constants.js';
import puppeteer from 'puppeteer';

const {
	STORE,
	PREVIEW_THEME_ID,
	LIVE_THEME_ID,
	SHOPIFY_STOREFRONT_PASSWORD,
	PRODUCT_HANDLE,
	RUNS = '4', // even, so each theme goes first equally often
	OUTPUT_DIR = 'lighthouse-results',
	GITHUB_OUTPUT
} = process.env;

// A check fails when the preview is worse than live by more than these amounts.
//
// Calibrated by auditing the live theme against itself (2026-10-11): JavaScript size and file counts
// varied by under 2 KB and 1 file, total weight by up to ~50 KB, so those limits are reliable. Timing
// varied a lot between identical runs (TBT medians by up to ~210 ms, LCP by ~370 ms, score by ~6.5),
// so those limits only catch big slowdowns. Timing limits need both a percentage and an absolute
// amount, so small numbers don't fail on noise.
const KB = 1024;
const CHECKS = [
	{ key: 'performance', label: 'Performance score', format: whole, fails: (live, preview) => live - preview > 10 },
	{ key: 'lcp', label: 'Largest Contentful Paint', format: ms, fails: (live, preview) => slower(live, preview, 0.15, 500) },
	{ key: 'tbt', label: 'Total Blocking Time', format: ms, fails: (live, preview) => slower(live, preview, 0.5, 400) },
	{ key: 'cls', label: 'Cumulative Layout Shift', format: (v) => v.toFixed(3), fails: (live, preview) => preview - live > 0.05 },
	{ key: 'jsBytes', label: 'JavaScript size', format: kb, fails: (live, preview) => preview - live > 25 * KB },
	{ key: 'totalBytes', label: 'Total page weight', format: kb, fails: (live, preview) => preview - live > 150 * KB },
	{ key: 'requests', label: 'Files loaded (scripts, styles, images, fonts)', format: whole, fails: (live, preview) => preview - live > 5 },
	// Accessibility is an absolute floor, but a store that is already below it shouldn't fail every PR.
	{ key: 'accessibility', label: 'Accessibility score', format: whole, fails: (live, preview) => preview < 90 && preview < live }
];

const STATIC_TYPES = ['document', 'script', 'stylesheet', 'image', 'font', 'media'];

function slower(live, preview, ratio, minMs) {
	const delta = preview - live;
	return delta > minMs && delta > live * ratio;
}
function whole(v) {
	return `${Math.round(v)}`;
}
function ms(v) {
	return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}
function kb(v) {
	return `${Math.round(v / KB)} KB`;
}
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const origin = `https://${STORE}`;
// Every URL names its theme explicitly, including live, so a preview cookie from an earlier audit
// can never leak into a live audit. `_fd=0&pb=0` turns off Shopify's preview bar, which would add
// its own scripts and skew the results.
const themeUrl = (themeId, pagePath) => `${origin}${pagePath}?preview_theme_id=${themeId}&_fd=0&pb=0`;

async function logIn(page) {
	if (!SHOPIFY_STOREFRONT_PASSWORD) return;
	await page.goto(`${origin}/password`, { waitUntil: 'domcontentloaded' });
	const field = await page.$('input[type="password"]');
	if (!field) return; // Store isn't password-protected after all.
	await field.type(SHOPIFY_STOREFRONT_PASSWORD);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), field.press('Enter')]);
	await page.goto(origin, { waitUntil: 'domcontentloaded' });
	if (new URL(page.url()).pathname.startsWith('/password')) throw new Error('The storefront password was rejected.');
}

// Make sure each URL really renders the theme we think it does before trusting any numbers.
async function assertTheme(page, themeId) {
	await page.goto(themeUrl(themeId, '/'), { waitUntil: 'domcontentloaded' });
	const served = await page.evaluate(() => window.Shopify?.theme?.id);
	if (String(served) !== String(themeId)) throw new Error(`Expected theme ${themeId} but the store served theme ${served}.`);
}

async function pickProduct(page) {
	if (PRODUCT_HANDLE) return PRODUCT_HANDLE;
	await page.goto(origin, { waitUntil: 'domcontentloaded' });
	const data = await page.evaluate(() => fetch('/products.json?limit=1').then((r) => r.json()));
	return data.products?.[0]?.handle ?? null;
}

// The first request for a page makes Shopify's CDN generate its resized images, which makes that load
// much slower than every later one. Live is kept warm by shoppers but a fresh preview isn't, so load
// every page once, unmeasured, on Lighthouse's own mobile screen (so the same image sizes are requested).
async function warmUp(browser, urls) {
	const { mobile, ...viewport } = screenEmulationMetrics.mobile;
	for (const url of urls) {
		const page = await browser.newPage();
		await page.setUserAgent(userAgents.mobile);
		await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: true });
		await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
		await page.close();
	}
}

const launchBrowser = () => puppeteer.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });

// Each audit gets a brand-new Chrome, as Lighthouse's own tooling does: a shared browser keeps network
// connections warm between audits, which made whichever theme ran second look faster. The storefront
// login is carried in via its session cookie, and Lighthouse's storage reset (which would delete that
// cookie) is turned off; a new browser starts with an empty cache anyway.
async function audit(url, sessionCookies) {
	const browser = await launchBrowser();
	try {
		if (sessionCookies.length) await browser.setCookie(...sessionCookies);
		const page = await browser.newPage();
		return await lighthouse(
			url,
			{ output: 'html', onlyCategories: ['performance', 'accessibility'], disableStorageReset: true, logLevel: 'error' },
			undefined,
			page
		);
	} finally {
		await browser.close();
	}
}

function metricsFrom(lhr) {
	const resources = Object.fromEntries((lhr.audits['resource-summary']?.details?.items ?? []).map((i) => [i.resourceType, i]));
	return {
		performance: Math.round(lhr.categories.performance.score * 100),
		accessibility: Math.round(lhr.categories.accessibility.score * 100),
		lcp: lhr.audits['largest-contentful-paint'].numericValue,
		tbt: lhr.audits['total-blocking-time'].numericValue,
		cls: lhr.audits['cumulative-layout-shift'].numericValue,
		jsBytes: resources.script?.transferSize ?? 0,
		totalBytes: resources.total?.transferSize ?? 0,
		// Excludes "other" requests (analytics beacons and the like), whose count varied by ~50 between
		// identical runs. The file types counted here varied by at most 1.
		requests: STATIC_TYPES.reduce((sum, type) => sum + (resources[type]?.requestCount ?? 0), 0),
		// Not a check; kept in results.json to see which kinds of request vary between runs.
		requestsByType: Object.fromEntries(Object.entries(resources).map(([type, i]) => [type, i.requestCount]))
	};
}

// The run to keep the full report for: the one whose performance score is closest to the median.
function representativeRun(list, medianScore) {
	return list.reduce((best, r) => (Math.abs(r.metrics.performance - medianScore) < Math.abs(best.metrics.performance - medianScore) ? r : best));
}

async function main() {
	for (const [name, value] of Object.entries({ STORE, PREVIEW_THEME_ID, LIVE_THEME_ID })) {
		if (!value) throw new Error(`${name} is not set.`);
	}
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const themes = [
		{ key: 'live', id: LIVE_THEME_ID },
		{ key: 'preview', id: PREVIEW_THEME_ID }
	];

	// One browser to log in, check both themes, choose a product and warm the pages up.
	let product, pages, sessionCookies;
	const setupBrowser = await launchBrowser();
	try {
		const page = await setupBrowser.newPage();
		await logIn(page);
		await assertTheme(page, LIVE_THEME_ID);
		await assertTheme(page, PREVIEW_THEME_ID);
		product = await pickProduct(page);
		pages = [
			{ name: 'Home', path: '/' },
			{ name: 'Collection', path: '/collections/all' },
			...(product ? [{ name: 'Product', path: `/products/${product}` }] : [])
		];
		await page.close();
		await warmUp(setupBrowser, pages.flatMap((p) => themes.map((t) => themeUrl(t.id, p.path))));
		// Shopify keeps a storefront unlocked by marking the `_shopify_essential` session as logged in.
		// Only that cookie is carried into each audit, so analytics cookies don't make audits look like
		// returning visitors. If Shopify ever changes this, every audit lands on /password and fails below.
		sessionCookies = SHOPIFY_STOREFRONT_PASSWORD ? (await setupBrowser.cookies()).filter((c) => c.name === '_shopify_essential') : [];
	} finally {
		await setupBrowser.close();
	}

	// runs[page][theme] = [{ metrics, report }]
	const runs = Object.fromEntries(pages.map((p) => [p.name, { live: [], preview: [] }]));
	const runCount = Number(RUNS);
	for (let run = 1; run <= runCount; run++) {
		for (const p of pages) {
			// Alternate which theme goes first, so any leftover ordering effect cancels out.
			for (const theme of run % 2 ? themes : [...themes].reverse()) {
				const result = await audit(themeUrl(theme.id, p.path), sessionCookies);
				const finalPath = new URL(result.lhr.finalDisplayedUrl).pathname;
				if (finalPath.startsWith('/password')) throw new Error(`${p.name} (${theme.key}) landed on the password page.`);
				runs[p.name][theme.key].push({ metrics: metricsFrom(result.lhr), report: result.report });
				console.log(`run ${run}/${runCount}  ${p.name.padEnd(10)} ${theme.key.padEnd(7)} score ${runs[p.name][theme.key].at(-1).metrics.performance}`);
			}
		}
	}

	const results = pages.map((p) => {
		const byTheme = {};
		for (const theme of themes) {
			const list = runs[p.name][theme.key];
			const medians = Object.fromEntries(CHECKS.map((c) => [c.key, median(list.map((r) => r.metrics[c.key]))]));
			const representative = representativeRun(list, medians.performance);
			fs.writeFileSync(path.join(OUTPUT_DIR, `${p.name.toLowerCase()}-${theme.key}.html`), representative.report);
			byTheme[theme.key] = medians;
		}
		const checks = CHECKS.map((c) => ({ ...c, live: byTheme.live[c.key], preview: byTheme.preview[c.key], failed: c.fails(byTheme.live[c.key], byTheme.preview[c.key]) }));
		// Every run's numbers too, for tuning the limits and investigating a failure.
		const perRun = Object.fromEntries(themes.map((t) => [t.key, runs[p.name][t.key].map((r) => r.metrics)]));
		return { page: p.name, path: p.path, checks, perRun };
	});

	const failed = results.some((r) => r.checks.some((c) => c.failed));
	fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify({ product, runs: runCount, failed, results }, (k, v) => (typeof v === 'function' ? undefined : v), 2));
	fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.md'), summary(results, failed, runCount));
	if (GITHUB_OUTPUT) fs.appendFileSync(GITHUB_OUTPUT, `result=${failed ? 'fail' : 'pass'}\n`);
	console.log(failed ? 'Preview is slower or heavier than live beyond the budget.' : 'Preview is within budget.');
}

function change(check) {
	// For whole-number measures, use the rounded values shown in the table, so "75 → 75" never reads "+1".
	const delta = check.format === whole ? Math.round(check.preview) - Math.round(check.live) : check.preview - check.live;
	const size = check.format(Math.abs(delta));
	// Show "–" when the difference rounds away to nothing (e.g. 0.3 KB).
	if (size === check.format(0)) return '–';
	return `${delta > 0 ? '+' : '−'}${size}`;
}

function summary(results, failed, runCount) {
	const lines = [
		`### ${failed ? '❌ Lighthouse: preview is over budget' : '✅ Lighthouse: preview is within budget'}`,
		'',
		`Mobile, median of ${runCount} runs per page, preview compared with the live theme in the same job.`,
		''
	];
	for (const r of results) {
		const pageFailed = r.checks.some((c) => c.failed);
		lines.push(
			`<details${pageFailed ? ' open' : ''}><summary><b>${pageFailed ? '❌' : '✅'} ${r.page}</b> <code>${r.path}</code></summary>`,
			'',
			'| | Live | Preview | Change |',
			'|---|---|---|---|',
			...r.checks.map((c) => `| ${c.failed ? '❌' : ''} ${c.label} | ${c.format(c.live)} | ${c.format(c.preview)} | ${change(c)} |`),
			'',
			'</details>',
			''
		);
	}
	return lines.join('\n');
}

main().catch((error) => {
	console.log(`::error::${error.message.split('\n')[0]}`);
	console.error(error);
	process.exit(1);
});
