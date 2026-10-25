// Keeps one preview theme in step with each pull request.
//   - creates it (a copy of the live theme with the PR's code pushed on top)
//   - updates the same theme on every push
//   - deletes it when the PR closes, gets the `no-preview` label or stops changing theme files.
// Results are posted as a single PR comment that is edited in place.
// Run by .github/workflows/pr-preview.yml. Set DRY_RUN=1 to print the store and GitHub changes instead of making them (theme list still runs so the CLI must be logged in).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseToml } from 'smol-toml';
import { github, run, setOutputs, upsertComment } from './github.mjs';

const {
	SHOPIFY_ENVIRONMENT = 'default',
	PR_NUMBER,
	PR_BRANCH,
	PR_HEAD_SHA = '',
	PR_ACTION,
	PR_LABELS = '[]',
	PR_IS_FORK = 'false',
	DIFF_BASE = 'HEAD^1',
	DRY_RUN
} = process.env;

const dryRun = Boolean(DRY_RUN);
const OPT_OUT_LABEL = 'no-preview';
const COMMENT_MARKER = 'theme-preview';
const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];

// The prefix (with its trailing separator) identifies this PR's theme so "PR #1 · " never matches "PR #12 · ".
const themePrefix = `PR #${PR_NUMBER} · `;
const themeName = `${themePrefix}${PR_BRANCH}`.slice(0, 50); // Shopify's limit on theme names

function readIgnorePatterns() {
	const config = parseToml(fs.readFileSync('shopify.theme.toml', 'utf8'));
	const environment = config.environments?.[SHOPIFY_ENVIRONMENT];
	if (!environment) throw new Error(`No [environments.${SHOPIFY_ENVIRONMENT}] in shopify.theme.toml`);
	return environment.ignore ?? [];
}

function shopify(args) {
	const fullArgs = ['theme', ...args, `--environment=${SHOPIFY_ENVIRONMENT}`];
	// On Windows the CLI is a .cmd shim that only runs through a shell, so build a quoted command line.
	const result =
		process.platform === 'win32'
			? spawnSync(['shopify', ...fullArgs.map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' '), { encoding: 'utf8', shell: true })
			: spawnSync('shopify', fullArgs, { encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`shopify theme ${args[0]} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

// The CLI sometimes prints notices (e.g. "new version available") around its JSON so take the first complete JSON value rather than the whole of stdout.
function parseJsonOutput(stdout) {
	const start = stdout.search(/[[{]/);
	if (start !== -1) {
		const closer = stdout[start] === '[' ? ']' : '}';
		for (let end = stdout.lastIndexOf(closer); end > start; end = stdout.lastIndexOf(closer, end - 1)) {
			try {
				return JSON.parse(stdout.slice(start, end + 1));
			} catch {
				// Not a complete value yet, try the next closing bracket further back.
			}
		}
	}
	throw new Error(`Expected JSON from the Shopify CLI, got:\n${stdout}`);
}

const shopifyJson = (args) => parseJsonOutput(shopify([...args, '--json']));

// Store changes go through here so a dry run can show them without making them.
function mutate(description, args, fakeResult, exec = shopifyJson) {
	if (dryRun) {
		console.log(`[dry run] would ${description}: shopify theme ${args.join(' ')}`);
		return fakeResult;
	}
	console.log(`${description}…`);
	return exec(args);
}

function changesThemeFiles(ignorePatterns) {
	const result = spawnSync('git', ['diff', '--name-only', DIFF_BASE, 'HEAD'], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr}`);
	const changed = result.stdout.split('\n').filter(Boolean);
	return changed.some(
		(file) => THEME_DIRS.includes(file.split('/')[0]) && !ignorePatterns.some((pattern) => path.matchesGlob(file, pattern))
	);
}

async function postComment(body) {
	if (dryRun) return console.log(`[dry run] would post or update the PR comment:\n${body}`);
	await upsertComment(COMMENT_MARKER, body);
}

function previewComment(theme, ignorePatterns) {
	const ignored = ignorePatterns.map((p) => `\`${p}\``).join(' or ');
	const lines = [
		'### 🛍️ Theme preview',
		'',
		`**[Open preview](${theme.preview_url})** · [Open in theme editor](${theme.editor_url})`,
		'',
		`Theme \`${theme.name}\` (ID \`${theme.id}\`), updated for commit \`${PR_HEAD_SHA.slice(0, 7)}\`.`,
		''
	];
	if (theme.warning) lines.push(`> ⚠️ ${theme.warning}. See the workflow log for details.`, '');
	lines.push(
		`It's a copy of the live theme with this PR's code on top.` +
			(ignored ? ` Settings and templates come from live, so changes to ${ignored} won't show here.` : ''),
		`It's deleted automatically when this PR closes. Add the \`${OPT_OUT_LABEL}\` label to remove it sooner.`
	);
	return lines.join('\n');
}

function reasonForNoPreview(ignorePatterns) {
	if (PR_ACTION === 'closed') return 'this pull request was closed';
	if (JSON.parse(PR_LABELS).includes(OPT_OUT_LABEL)) return `the \`${OPT_OUT_LABEL}\` label was added`;
	if (!changesThemeFiles(ignorePatterns)) return "this pull request doesn't change any theme files";
	return null;
}

// `theme duplicate` returns while Shopify is still copying files in the background (`processing: true`). Pushing before that finishes lets the copy overwrite the PR's changes.
async function waitUntilReady(themeId) {
	if (dryRun) return;
	const deadline = Date.now() + 5 * 60_000;
	for (;;) {
		const theme = shopifyJson(['list']).find((t) => t.id === themeId);
		if (!theme) throw new Error(`Preview theme ${themeId} disappeared while waiting for it to finish copying.`);
		if (!theme.processing) return;
		if (Date.now() > deadline) throw new Error(`Preview theme ${themeId} was still copying after 5 minutes.`);
		console.log(`Theme ${themeId} is still copying, waiting 5s…`);
		await sleep(5_000);
	}
}

// Runs for a PR are queued in order so if newer commits have been pushed since this run started, a run for the latest one is already waiting and will redo everything from the current state. Checking this commit would be wasted work. Closing always runs because the preview must be deleted.
async function newerCommit() {
	if (dryRun || PR_ACTION === 'closed') return null;
	const pr = await github('GET', `/repos/${process.env.GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`);
	return pr.head.sha === PR_HEAD_SHA ? null : pr.head.sha;
}

function assertNotLive(theme) {
	// Belt and braces. Nothing in this script should ever touch the live theme.
	if (theme.role === 'live') throw new Error(`Refusing to modify the live theme (${theme.id} "${theme.name}")`);
}

async function main() {
	if (!process.env.SHOPIFY_CLI_THEME_TOKEN && !dryRun) {
		// GitHub withholds secrets from PRs opened from forks so they can't get a preview.
		if (PR_IS_FORK === 'true') return console.log('Skipping: pull requests from forks cannot access the store password.');
		throw new Error('The SHOPIFY_CLI_THEME_TOKEN secret is not set. Add a Theme Access password under Settings → Secrets and variables → Actions.');
	}

	const newer = await newerCommit();
	if (newer) return console.log(`Skipping: commit ${newer.slice(0, 7)} has been pushed since, and its queued run will update the preview.`);

	const ignorePatterns = readIgnorePatterns();
	const themes = shopifyJson(['list']);
	const live = themes.find((theme) => theme.role === 'live');
	const existing = themes.find((theme) => theme.name.startsWith(themePrefix));
	if (existing) assertNotLive(existing);

	const reason = reasonForNoPreview(ignorePatterns);
	if (reason) {
		if (!existing) return console.log(`No preview needed: ${reason}.`);
		// `theme delete` has no --json flag so it runs through plain `shopify`.
		mutate(`delete preview theme ${existing.id}`, ['delete', `--theme=${existing.id}`, '--force'], null, shopify);
		await postComment(`### Theme preview removed\n\nThe preview theme \`${existing.name}\` was deleted because ${reason}.`);
		return;
	}

	let themeId = existing?.id;
	if (existing) {
		console.log(`Updating existing preview theme ${existing.id} "${existing.name}".`);
	} else {
		if (!live) throw new Error('No live theme found to copy.');
		const duplicated = mutate(
			`copy live theme ${live.id} as "${themeName}"`,
			['duplicate', `--theme=${live.id}`, `--name=${themeName}`, '--force'],
			{ theme: { id: 'DRY-RUN-ID', name: themeName, role: 'unpublished' } }
		);
		assertNotLive(duplicated.theme);
		themeId = duplicated.theme.id;
	}

	// A new copy is still being filled in by Shopify. An existing preview usually isn't and the theme list above already says so, which saves a second lookup.
	if (!existing || existing.processing) await waitUntilReady(themeId);
	const pushed = mutate(`push PR code to theme ${themeId}`, ['push', `--theme=${themeId}`], {
		theme: { id: themeId, name: themeName, preview_url: 'https://example.com/preview', editor_url: 'https://example.com/editor' }
	});

	if (pushed.theme.warning) console.log(`::warning::${pushed.theme.warning}`);
	await postComment(previewComment(pushed.theme, ignorePatterns));
	// Hands the theme IDs to the Lighthouse job.
	setOutputs({ theme_id: themeId, live_theme_id: live?.id ?? '', store: pushed.theme.shop ?? '' });
	console.log(`Preview: ${pushed.theme.preview_url}`);
}

run(main);
