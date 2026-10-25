// Shared GitHub Actions helpers for the scripts in this folder.
//   github         calls the GitHub REST API
//   upsertComment  keeps one PR comment per marker up to date instead of adding a new one every run
//   setOutputs     passes values on to later steps and jobs
//   run            runs a script's main function and turns a thrown error into a failed step with an annotation
// From a workflow step. `node .github/scripts/github.mjs <marker> <body-file>`
// Comments need GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER in the environment.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function github(method, url, body) {
	const response = await fetch(`https://api.github.com${url}`, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		},
		body: body && JSON.stringify(body)
	});
	if (!response.ok) throw new Error(`GitHub ${method} ${url} failed: ${response.status} ${await response.text()}`);
	return response.json();
}

export async function upsertComment(marker, body) {
	const { GITHUB_REPOSITORY, PR_NUMBER } = process.env;
	const tag = `<!-- ${marker} -->`;
	const comments = await github('GET', `/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100`);
	const existing = comments.find((comment) => comment.body?.startsWith(tag));
	const payload = { body: `${tag}\n${body}` };
	if (existing) await github('PATCH', `/repos/${GITHUB_REPOSITORY}/issues/comments/${existing.id}`, payload);
	else await github('POST', `/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, payload);
}

export function setOutputs(outputs) {
	if (!process.env.GITHUB_OUTPUT) return;
	fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

export function run(main) {
	main().catch((error) => {
		console.log(`::error::${error.message.split('\n')[0]}`);
		console.error(error);
		process.exit(1);
	});
}

// Run directly from a workflow step.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [marker, bodyFile] = process.argv.slice(2);
	await upsertComment(marker, fs.readFileSync(bodyFile, 'utf8'));
	console.log(`Posted the ${marker} comment.`);
}
