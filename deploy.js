#!/usr/bin/env node

import yoctoSpinner from 'yocto-spinner';
import { parse as parseToml } from 'smol-toml';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';
import { checkbox, confirm, Separator } from '@inquirer/prompts';
import { styleText } from 'node:util';

const themeEditorUrl = (store, themeID) => `https://${store}/admin/themes/${themeID}/editor`;

// OSC 8: renders `label` as a clickable link in modern terminals.
const hyperlink = (label, url) => (process.stdout.isTTY ? `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\` : label);

// ── Terminal presentation helpers ───────────────────────────────────────────
const SUPPORTS_UNICODE = process.platform !== 'win32' || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
const icon = (fancy, plain) => (SUPPORTS_UNICODE ? fancy : plain);

const promptTheme = {
	prefix: { idle: styleText('cyan', icon('▸', '>')), done: styleText('green', icon('✔', 'v')) },
	style: {
		message: (text) => styleText('bold', text),
		answer: (text) => styleText('cyan', text),
		error: (text) => styleText('red', `${icon('✖', 'x')} ${text}`),
		highlight: (text) => styleText('cyan', text)
	}
};

const checkboxTheme = {
	...promptTheme,
	icon: { checked: icon('◉', '(*)'), unchecked: icon('○', '( )'), cursor: icon('▸', '>') }
};

const execAsync = promisify(exec);

deploy().catch((error) => {
	if (error?.name === 'ExitPromptError') {
		console.log('\n Operation cancelled.');
		process.exit(0);
	}

	// Other errors
	console.error(error);
	process.exit(1);
});

async function deploy() {
	console.clear();
	heading('Shopify Theme Deploy');

	const currentBranch = await getCurrentBranch();
	if (currentBranch && currentBranch !== 'main') {
		console.log( styleText('yellowBright', `⚠ Warning: You are not deploying from the main branch. This branch is ${styleText('bold', currentBranch)}` ) );

		const continueDeploy = await confirm({
			message: 'Do you wish to continue deploying from this branch?',
			default: false,
			theme: promptTheme
		});

		if (!continueDeploy) {
			console.log(styleText('greenBright', '\nOperation cancelled.'));
			process.exit(0);
		}
	}

	const stores = getStores();
	if (stores.size === 0) {
		console.error(styleText('yellowBright', '⚠ Error: No stores found in shopify.theme.toml. Please ensure the file is correctly configured.'));
		return;
	}
	const themesGrouped = await getGroupedThemeOptions(stores);

	const themeOptions = themesGrouped.flatMap(group => [group.separator, ...group.themes]);

	if (themeOptions.length === 0) {
		console.error(styleText('yellowBright', '⚠ Error: No themes found in any store. Process aborted.'));
		return;
	}

	const selectedThemes = await checkbox({
		message: 'Select which themes to deploy to (use spacebar to select, arrows to navigate, hit enter to initiate deployment):',
		choices: themeOptions,
		loop: false,
		pageSize: (process.stdout.rows || 24) - 4,
		validate(answer) {
			return answer.length ? true : 'Error: No theme selected';
		},
		theme: checkboxTheme
	});

	console.log(styleText('greenBright', '\n✔ Confirmed: The following themes were selected.\n'));

	selectedThemes.forEach(({ environment, store, themeID, themeName, role }) => {
		console.log(
			styleText('greenBright', `${icon('→', '->')} `) +
			hyperlink(styleText(['greenBright', 'bold'], themeName), themeEditorUrl(store, themeID)) +
			styleText('greenBright', ` (${themeID}) on ${store}`) +
			(role ? ' ' + styleText('inverse', ` ${role} `) : '')
		);
	});

	console.log(); // Spacing

	let successCount = 0;
	let failureCount = 0;

	for (const [index, { environment, store, themeID, themeName }] of selectedThemes.entries()) {
		console.log(
			styleText('dim', `[${index + 1}/${selectedThemes.length}] `) +
			styleText(
				'greenBright',
				`Deploying code to ${styleText('bold', themeName)} on ${styleText('bold', store)}...`
			)
		);

		const command = `shopify theme push --environment=${environment} --theme=${themeID}`;

		try {
			await spawnInteractive(command);
			successCount++;
			console.log(styleText('green', `${icon('✔', 'v')} Deployed to `) + hyperlink(styleText(['green', 'underline'], themeName), themeEditorUrl(store, themeID)) + '\n');
		} catch (error) {
			failureCount++;
			console.error(
				styleText('red', `✖ Error: Failed to deploy to ${themeID} on store ${store}:`),
				error.message || error
			);
			console.log();
		}
	}

	const summary = [
		styleText('green', `${icon('✔', 'v')} ${successCount} succeeded`),
		failureCount > 0 ? styleText('red', `${icon('✖', 'x')} ${failureCount} failed`) : null
	].filter(Boolean).join(styleText('dim', '  ·  '));

	console.log(summary + '\n');
}

async function getGroupedThemeOptions(stores, spinnerText = 'Fetching from shopify.theme.toml...') {
	const totalStores = stores.size;
	const spinner = yoctoSpinner({ text: `${spinnerText} (0/${totalStores})`, color: 'green' }).start();
	const themesGrouped = [];
	let storesFetched = 0;

	try {
		for (const [store, environment] of stores) {
			const themes = await getThemeOptions(environment, store);
			if (themes.length > 0) {
				themesGrouped.push({
					separator: new Separator(
						styleText('yellowBright', '[ ') +
						styleText(['yellowBright', 'bold'], store) +
						styleText('yellowBright', ' ]') +
						styleText('dim', `  ( ${themes.length} ${themes.length === 1 ? 'theme' : 'themes'} )`)
					),
					themes
				});
			}
			spinner.text = `${spinnerText} (${++storesFetched}/${totalStores})`;
		}
	} finally {
		spinner.stop();
	}

	return themesGrouped;
}

async function getThemeOptions(environment, store) {
	try {
		const { stdout: themeListJson } = await execAsync(`shopify theme list --environment=${environment} --json`);
		return JSON.parse(themeListJson).filter(theme => (theme?.role || '').toLowerCase() !== 'development').map(theme => ({
			name: styleText(['white', 'bold'], `${theme.id}: ${theme.name} (${theme.role || 'unpublished'})`),
			value: { environment, store, themeID: theme.id, role: theme.role, themeName: theme.name }
		}));
	} catch (error) {
		const stderr = error?.stderr || '';
		console.error(styleText('red', `✖ Error fetching themes from ${store}:`), stderr || error?.message || error);
		console.error(styleText('yellowBright', `Run "shopify theme list --store ${store} --json" to verify authentication for this store.`));
		return [];
	}
}

function getStores() {
	const tomlSource = fs.readFileSync('shopify.theme.toml', 'utf8');
	const config = parseToml(tomlSource);
	return new Map(Object.keys(config.environments).map(environmentName => [config.environments[environmentName]?.store?.trim(), environmentName]));
}

async function getCurrentBranch() {
	try {
		const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD');
		return stdout.trim();
	} catch (error) {
		console.error( styleText('yellowBright', 'Error: Cannot fetch current branch name. Ensure you are deploying from the main branch only'), error?.message || error );
		return null;
	}
}

function spawnInteractive(command) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { stdio: 'inherit', shell: true });
		child.on('close', (exitCode) => {
			if (exitCode === 0) {
				resolve();
			} else {
				reject(new Error(`Command exited with code ${exitCode}`));
			}
		});
		child.on('error', reject);
	});
}

function heading(text) {
	const box = SUPPORTS_UNICODE
		? { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│' }
		: { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|' };
	const bar = box.horizontal.repeat(text.length + 2);
	console.log(styleText('cyan', `\n${box.topLeft}${bar}${box.topRight}`));
	console.log(styleText('cyan', `${box.vertical} ${styleText('bold', text)} ${box.vertical}`));
	console.log(styleText('cyan', `${box.bottomLeft}${bar}${box.bottomRight}\n`));
}
