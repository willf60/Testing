#!/usr/bin/env node

import { styleText } from 'node:util';
import { checkbox, confirm, Separator } from '@inquirer/prompts';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';

const execPromise = promisify(exec);

function spawnInteractive(command) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { stdio: 'inherit', shell: true });
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Command exited with code ${code}`));
			}
		});
		child.on('error', reject);
	});
}

async function getCurrentBranch() {
	try {
		const { stdout } = await execPromise('git rev-parse --abbrev-ref HEAD');
		return stdout.trim();
	} catch (error) {
		console.error( styleText('yellowBright', 'Unable to determine current git branch. Main branch guard cannot be completed.'), error?.message || error );
		return null;
	}
}

function getEnvironments() {
	const raw = fs.readFileSync('shopify.theme.toml', 'utf8');
	const parsed = parseToml(raw);
	return new Map(Object.keys(parsed.environments).map(env => [parsed.environments[env]?.store?.trim(), env]));
}

async function getThemes(environment, store) {
	try {
		const { stdout: shopifyOutput } = await execPromise(`shopify theme list --environment=${environment} --json`);
		return JSON.parse(shopifyOutput).filter(theme => (theme?.role || '').toLowerCase() !== 'development').map(theme => ({
			name: styleText(['white', 'bold'], `${theme.id}: ${theme.name} (${theme.role || 'unpublished'})`),
			value: { environment, store, themeID: theme.id, role: theme.role, themeName: theme.name }
		}));
	} catch (error) {
		const stderr = error?.stderr || '';
		console.error(styleText('red', `✖ Error retrieving themes for ${store}:`), stderr || error?.message || error);
		console.error(styleText('yellowBright', `Try to run "shopify theme list --store ${store} --json" to verify authentication for this store.`));
		return [];
	}
}

async function getThemeSelectionList(environments, progressText = 'Fetching theme list for stores listed in shopify.theme.toml...') {
	const total = environments.size;
	const list = [];
	let counter = 0;

	console.log(styleText('yellowBright', `${progressText} (0/${total})`));

	for (const [store, environment] of environments) {
		const themes = await getThemes(environment, store);
		if (themes.length > 0) {
			list.push({
				separator: new Separator(styleText('yellowBright', `── ${store} ──`)),
				themes
			});
		}
		console.log(styleText('yellowBright', `${progressText} (${++counter}/${total})`));
	}

	return list;
}

async function deploy() {
	console.clear();

	const currentBranch = await getCurrentBranch();
	if (currentBranch && currentBranch !== 'main') {
		console.log( styleText('yellowBright', `⚠ You are deploying from branch ${styleText('bold', currentBranch)}, not the main branch.` ) );

		const continueDeploy = await confirm({
			message: 'Are you sure you want to continue deploying from this branch?',
			default: false
		});

		if (!continueDeploy) {
			console.log(styleText('greenBright', '\nDeployment cancelled.'));
			process.exit(0);
		}
	}

	const environments = getEnvironments();
	if (environments.size === 0) {
		console.error(styleText('yellowBright', '⚠ No stores configured. Ensure shopify.theme.toml is configured correctly.'));
		return;
	}
	const storeGroups = await getThemeSelectionList(environments);

	const storeGroupsUI = storeGroups.flatMap(group => [group.separator, ...group.themes]);

	if (storeGroupsUI.length === 0) {
		console.error(styleText('yellowBright', '⚠ No themes found in any store. Aborting deployment.'));
		return;
	}

	const selectedThemes = await checkbox({
		message: 'Select themes to deploy (use spacebar to select, arrows to navigate):',
		choices: storeGroupsUI,
		loop: false,
		pageSize: process.stdout.rows - 4,
		validate(answer) {
			return answer.length ? true : 'You must choose at least one theme.';
		}
	});

	console.log(styleText('greenBright', '\n✔ You selected the following themes to deploy to:\n'));

	selectedThemes.forEach(({ environment, store, themeID, themeName, role }) => {
		console.log( styleText('greenBright', `→ ${themeName} (${themeID}) on ${store}`) + (role ? styleText('white', ` [${role}]`) : '') );
	});

	console.log(); // Just for spacing

	for (const { environment, store, themeID, themeName } of selectedThemes) {
		console.log(
			styleText(
				'greenBright',
				`Pushing code to ${styleText('bold', themeName)} (${styleText('bold', String(themeID))}) on ${styleText('bold', store)}...`
			)
		);

		const command = `shopify theme push --environment=${environment} --theme=${themeID}`;

		try {
			await spawnInteractive(command);
		} catch (error) {
			console.error(
				styleText('red', `✖ Error deploying theme ${themeID} on store ${store}:`),
				error.message || error
			);
		}
	}
}

deploy().catch((err) => {
	// Ctrl+C
	if (err?.name === 'ExitPromptError') {
		console.log('\nCancelled.');
		process.exit(0);
	}

	// Other errors
	console.error(err);
	process.exit(1);
});