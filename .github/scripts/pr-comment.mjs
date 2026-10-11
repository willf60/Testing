// Posts a comment on the current pull request, or edits the one already posted with the same marker,
// so each workflow keeps a single comment up to date instead of adding a new one every run.
//
// As a module:  await upsertComment('theme-preview', body)
// From a step:  node .github/scripts/pr-comment.mjs <marker> <body-file>
//               (appends a reports link when ARTIFACT_URL is set)
//
// Needs GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER in the environment.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

async function github(method, url, body) {
	const response = await fetch(`https://api.github.com${url}`, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (!response.ok) throw new Error(`GitHub ${method} ${url} failed: ${response.status} ${await response.text()}`);
	return response.status === 204 ? null : response.json();
}

export async function upsertComment(marker, body) {
	const { GITHUB_REPOSITORY, PR_NUMBER } = process.env;
	const tag = `<!-- ${marker} -->`;
	const fullBody = `${tag}\n${body}`;
	const comments = await github('GET', `/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100`);
	const existing = comments.find((comment) => comment.body?.startsWith(tag));
	if (existing) await github('PATCH', `/repos/${GITHUB_REPOSITORY}/issues/comments/${existing.id}`, { body: fullBody });
	else await github('POST', `/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, { body: fullBody });
}

// Run directly from a workflow step.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [marker, bodyFile] = process.argv.slice(2);
	let body = fs.readFileSync(bodyFile, 'utf8');
	if (process.env.ARTIFACT_URL) body += `\n\n📄 [Download the full Lighthouse reports](${process.env.ARTIFACT_URL}) (HTML, one per page and theme).`;
	await upsertComment(marker, body);
	console.log(`Posted the ${marker} comment.`);
}
