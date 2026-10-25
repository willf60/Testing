// Runs Lighthouse (mobile) on the live theme and a PR's preview theme then fails if the preview is meaningfully slower or heavier than live. Both themes are audited in the same run, on the same machine, against the same store content so the PR's code is the only real difference.
// Writes to OUTPUT_DIR. `summary.md` (the PR comment), `results.json` and one HTML report per page and theme (the median run). Exits with an error if the preview is over budget or if the comparison couldn't be completed, in which case summary.md says so rather than leaving an old result in place.
// Run by .github/workflows/pr-preview.yml. Needs lighthouse and puppeteer installed.

import fs from 'node:fs';
import path from 'node:path';
import lighthouse from 'lighthouse';
import { screenEmulationMetrics, userAgents } from 'lighthouse/core/config/constants.js';
import { computeMedianRun } from 'lighthouse/core/lib/median-run.js';
import puppeteer from 'puppeteer';
import { run } from './github.mjs';

const {
	STORE,
	PREVIEW_THEME_ID,
	LIVE_THEME_ID,
	SHOPIFY_STOREFRONT_PASSWORD,
	PRODUCT_HANDLE,
	PR_HEAD_SHA = '',
	RUNS = '4', // even, so each theme goes first equally often. Important because the theme measured first in a pair (live theme vs PR theme) tends to come out slower. This makes it a fair test.
	OUTPUT_DIR = 'lighthouse-results',
	GITHUB_SERVER_URL,
	GITHUB_REPOSITORY,
	GITHUB_RUN_ID
} = process.env;

const SUMMARY = path.join(OUTPUT_DIR, 'summary.md');
const commit = `\`${PR_HEAD_SHA.slice(0, 7)}\``;

// A check fails when the preview is worse than live by more than these amounts.
// Sizes barely change between runs so even small increases fail. Timings vary a lot between runs so they only fail when the preview is slower by both a percentage and a minimum amount (e.g. 25% and 1 s for LCP). `step` is how precisely each value is shown in the PR comment.
const KB = 1024;
const CHECKS = [
	{ key: 'performance', label: 'Performance score', format: whole, step: 1, fails: (live, preview) => live - preview > 10 },
	{ key: 'lcp', label: 'Largest Contentful Paint', format: ms, step: 1, fails: (live, preview) => slower(live, preview, 0.25, 1000) },
	{ key: 'tbt', label: 'Total Blocking Time', format: ms, step: 1, fails: (live, preview) => slower(live, preview, 0.5, 400) },
	{ key: 'cls', label: 'Cumulative Layout Shift', format: (v) => v.toFixed(3), step: 0.001, fails: (live, preview) => preview - live > 0.05 },
	{ key: 'jsBytes', label: 'JavaScript size', format: kb, step: KB, fails: (live, preview) => preview - live > 25 * KB },
	{ key: 'totalBytes', label: 'Total page weight', format: kb, step: KB, fails: (live, preview) => preview - live > 150 * KB },
	{ key: 'requests', label: 'Files loaded (scripts, styles, images, fonts)', format: whole, step: 1, fails: (live, preview) => preview - live > 5 },
	// Accessibility is an absolute floor but a store that is already below it shouldn't fail every PR.
	{ key: 'accessibility', label: 'Accessibility score', format: whole, step: 1, fails: (live, preview) => preview < 90 && preview < live }
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
// Every URL names its theme explicitly (including live) so a preview cookie from an earlier audit can never leak into a live audit. `_fd=0&pb=0` turns off Shopify's preview bar, which would add its own scripts and skew the results.
const themeUrl = (themeId, pagePath) => `${origin}${pagePath}?preview_theme_id=${themeId}&_fd=0&pb=0`;

async function logIn(page) {
	if (!SHOPIFY_STOREFRONT_PASSWORD) return;
	await page.goto(`${origin}/password`, { waitUntil: 'domcontentloaded' });
	const field = await page.$('input[type="password"]');
	if (!field) return; // Store isn't password-protected after all.
	await field.type(SHOPIFY_STOREFRONT_PASSWORD);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), field.press('Enter')]);
	// A correct password redirects to the home page, a wrong one shows the password page again.
	if (new URL(page.url()).pathname.startsWith('/password')) throw new Error('The storefront password was rejected.');
}

async function pickProduct(page) {
	if (PRODUCT_HANDLE) return PRODUCT_HANDLE;
	const response = await page.goto(`${origin}/products.json?limit=1`);
	return (await response.json()).products?.[0]?.handle ?? null;
}

// The first request for a page makes Shopify's CDN generate its resized images, which makes that load much slower than every later one. Live is kept warm by shoppers but a fresh preview isn't, so load every page once (unmeasured) on Lighthouse's own mobile screen (so the same image sizes are requested). Each load also confirms the store really served the theme we asked for before trusting any numbers.
async function warmUp(browser, pages, themes) {
	const { mobile, ...viewport } = screenEmulationMetrics.mobile;
	const load = async (p, theme) => {
		const page = await browser.newPage();
		await page.setUserAgent(userAgents.mobile);
		await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: true });
		await page.goto(themeUrl(theme.id, p.path), { waitUntil: 'networkidle2', timeout: 60_000 });
		const served = await page.evaluate(() => window.Shopify?.theme?.id);
		if (String(served) !== String(theme.id)) throw new Error(`${p.name}: expected theme ${theme.id} but the store served theme ${served}.`);
		await page.close();
	};
	// Nothing is measured yet, so each theme's pages load at once, the themes go one after the other.
	for (const theme of themes) await Promise.all(pages.map((p) => load(p, theme)));
}

const launchBrowser = () => puppeteer.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });

// Each audit gets a brand-new Chrome as Lighthouse's own tooling does. A shared browser keeps network connections warm between audits, which makes whichever theme runs second look faster. The storefront login is carried in via its session cookie and Lighthouse's storage reset (which would delete that cookie) is turned off, a new browser starts with an empty cache anyway.
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
	const items = lhr.audits['resource-summary']?.details?.items;
	if (!items) throw new Error('Lighthouse returned no resource summary, so sizes could not be compared.');
	const resources = Object.fromEntries(items.map((i) => [i.resourceType, i]));
	return {
		performance: Math.round(lhr.categories.performance.score * 100),
		accessibility: Math.round(lhr.categories.accessibility.score * 100),
		lcp: lhr.audits['largest-contentful-paint'].numericValue,
		tbt: lhr.audits['total-blocking-time'].numericValue,
		cls: lhr.audits['cumulative-layout-shift'].numericValue,
		jsBytes: resources.script?.transferSize ?? 0,
		totalBytes: resources.total?.transferSize ?? 0,
		// Excludes "other" requests (analytics beacons and the like), whose count varies a lot between identical runs.
		requests: STATIC_TYPES.reduce((sum, type) => sum + (resources[type]?.requestCount ?? 0), 0),
		// Not a check, kept in results.json to see which kinds of request vary between runs.
		requestsByType: Object.fromEntries(Object.entries(resources).map(([type, i]) => [type, i.requestCount]))
	};
}

// One browser to log in, choose a product and warm up (and check) every page on both themes.
async function setUp(themes) {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage();
		await logIn(page);
		const product = await pickProduct(page);
		const pages = [
			{ name: 'Home', path: '/' },
			{ name: 'Collection', path: '/collections/all' },
			...(product ? [{ name: 'Product', path: `/products/${product}` }] : [])
		];
		await page.close();
		await warmUp(browser, pages, themes);
		// Shopify keeps a storefront unlocked by marking the `_shopify_essential` session as logged in. Only that cookie is carried into each audit so analytics cookies don't make audits look like returning visitors. If Shopify ever changes this, every audit lands on /password and fails below.
		const sessionCookies = SHOPIFY_STOREFRONT_PASSWORD ? (await browser.cookies()).filter((c) => c.name === '_shopify_essential') : [];
		return { product, pages, sessionCookies };
	} finally {
		await browser.close();
	}
}

async function main() {
	for (const [name, value] of Object.entries({ STORE, PREVIEW_THEME_ID, LIVE_THEME_ID })) {
		if (!value) throw new Error(`${name} is not set.`);
	}
	const themes = [
		{ key: 'live', id: LIVE_THEME_ID },
		{ key: 'preview', id: PREVIEW_THEME_ID }
	];

	const { product, pages, sessionCookies } = await setUp(themes);

	// runs[page][theme] = [{ lhr, metrics, report }]
	const runs = Object.fromEntries(pages.map((p) => [p.name, { live: [], preview: [] }]));
	const runCount = Number(RUNS);
	for (let round = 1; round <= runCount; round++) {
		for (const p of pages) {
			// Alternate which theme goes first so any leftover ordering effect cancels out.
			for (const theme of round % 2 ? themes : [...themes].reverse()) {
				const { lhr, report } = await audit(themeUrl(theme.id, p.path), sessionCookies);
				// A page that errored (e.g. a 404) scores 0 on both themes and would otherwise "pass".
				if (lhr.runtimeError || lhr.categories.performance.score === null) {
					throw new Error(`${p.name} (${theme.key}) didn't load properly: ${lhr.runtimeError?.message ?? 'no performance score'}`);
				}
				if (new URL(lhr.finalDisplayedUrl).pathname.startsWith('/password')) throw new Error(`${p.name} (${theme.key}) landed on the password page.`);
				const metrics = metricsFrom(lhr);
				runs[p.name][theme.key].push({ lhr, metrics, report });
				console.log(`run ${round}/${runCount}  ${p.name.padEnd(10)} ${theme.key.padEnd(7)} score ${metrics.performance}`);
			}
		}
	}

	const results = pages.map((p) => {
		const byTheme = {};
		for (const theme of themes) {
			const list = runs[p.name][theme.key];
			byTheme[theme.key] = Object.fromEntries(CHECKS.map((c) => [c.key, median(list.map((r) => r.metrics[c.key]))]));
			// Keep the full report of Lighthouse's own "median run" (the same pick Lighthouse CI uses).
			const medianLhr = computeMedianRun(list.map((r) => r.lhr));
			fs.writeFileSync(path.join(OUTPUT_DIR, `${p.name.toLowerCase()}-${theme.key}.html`), list.find((r) => r.lhr === medianLhr).report);
		}
		const checks = CHECKS.map((c) => {
			const [live, preview] = [byTheme.live[c.key], byTheme.preview[c.key]];
			return { ...c, live, preview, failed: c.fails(live, preview) };
		});
		// Every run's numbers too, for tuning the limits and investigating a failure.
		const perRun = Object.fromEntries(themes.map((t) => [t.key, runs[p.name][t.key].map((r) => r.metrics)]));
		return { page: p.name, path: p.path, checks, perRun };
	});

	const failed = results.some((r) => r.checks.some((c) => c.failed));
	fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify({ product, runs: runCount, failed, results }, null, 2));
	fs.writeFileSync(SUMMARY, summary(results, failed, runCount));
	return failed;
}

function change(check) {
	// Work from the values as displayed so e.g. "50 KB → 50 KB" never reads "+1 KB".
	const snap = (v) => Math.round(v / check.step) * check.step;
	const delta = snap(check.preview) - snap(check.live);
	if (delta === 0) return '–';
	return `${delta > 0 ? '+' : '−'}${check.format(Math.abs(delta))}`;
}

function summary(results, failed, runCount) {
	const lines = [
		`### ${failed ? '❌ Lighthouse: preview is over budget' : '✅ Lighthouse: preview is within budget'}`,
		'',
		`Commit ${commit}. Mobile, median of ${runCount} runs per page, preview compared with the live theme in the same job.`,
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

// If the comparison can't finish, the comment says so for this commit rather than the previous commit's result staying on the PR looking current.
run(async () => {
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	let failed;
	try {
		failed = await main();
	} catch (error) {
		const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
		fs.writeFileSync(SUMMARY, `### ⚠️ Lighthouse couldn't finish for commit ${commit}\n\n${error.message.split('\n')[0]}\n\nNo comparison was made for this commit, so any earlier result no longer applies. See the [workflow run](${runUrl}) for details.`);
		throw error;
	}
	if (failed) throw new Error('The preview is slower or heavier than live beyond the budget. See the Lighthouse comment on the PR.');
	console.log('Preview is within budget.');
});
