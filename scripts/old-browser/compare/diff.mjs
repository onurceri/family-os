// Compares the pictures capture.mjs took in the repo's Chromium and in Chromium 106, pair by
// pair, and writes a report that ranks the pairs by the share of changed pixels.
//
//   node scripts/old-browser/compare/diff.mjs <modern dir> <old dir> <report dir>
//
// The report is <report dir>/index.html (modern | 106 | diff for each pair) and results.json.
// Pictures of different heights are padded to the taller one with gray, which counts as changed:
// a page that is longer in one browser shows up as a large difference, not a crash.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const [modernDir, oldDir, reportDir] = process.argv.slice(2);
if (!modernDir || !oldDir || !reportDir)
	throw new Error('Usage: diff.mjs <modern dir> <old dir> <report dir>');

const pngs = (dir) => new Set(readdirSync(dir).filter((f) => f.endsWith('.png')));
const modern = pngs(modernDir);
const old = pngs(oldDir);
const names = [...modern].filter((f) => old.has(f)).sort();
const onlyModern = [...modern].filter((f) => !old.has(f)).sort();
const onlyOld = [...old].filter((f) => !modern.has(f)).sort();

const PAD = [200, 200, 200, 255];
function padded(png, width, height) {
	if (png.width === width && png.height === height) return png;
	const out = new PNG({ width, height });
	for (let i = 0; i < out.data.length; i += 4) out.data.set(PAD, i);
	PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
	return out;
}

mkdirSync(reportDir, { recursive: true });
const results = [];
for (const file of names) {
	const a = PNG.sync.read(readFileSync(join(modernDir, file)));
	const b = PNG.sync.read(readFileSync(join(oldDir, file)));
	const width = Math.max(a.width, b.width);
	const height = Math.max(a.height, b.height);
	const pa = padded(a, width, height);
	const pb = padded(b, width, height);
	const diff = new PNG({ width, height });
	const total = width * height;
	// Any visible difference, and the strong ones (a layout shift or a missing element, not a shade).
	const changed = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: 0.1 });
	const strong = pixelmatch(pa.data, pb.data, null, width, height, { threshold: 0.3 });
	const base = file.replace(/\.png$/, '');
	copyFileSync(join(modernDir, file), join(reportDir, `${base}.modern.png`));
	copyFileSync(join(oldDir, file), join(reportDir, `${base}.old.png`));
	writeFileSync(join(reportDir, `${base}.diff.png`), PNG.sync.write(diff));
	results.push({
		file,
		base,
		ratio: changed / total,
		strongRatio: strong / total,
		changed,
		width,
		heights: [a.height, b.height],
		widths: [a.width, b.width],
	});
}
results.sort((x, y) => y.ratio - x.ratio);
writeFileSync(
	join(reportDir, 'results.json'),
	JSON.stringify({ results, onlyModern, onlyOld }, null, 2),
);

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const rows = results
	.map((r, i) => {
		const taller = r.heights[0] !== r.heights[1];
		return `<section id="${esc(r.base)}">
<h2>${i + 1}. ${esc(r.base)} <span class="n">changed ${pct(r.ratio)} &middot; strong ${pct(r.strongRatio)}${
			taller ? ` &middot; <b>height ${r.heights[0]} vs ${r.heights[1]}</b>` : ''
		}</span></h2>
<div class="row">
<a href="${esc(r.base)}.modern.png"><img loading="lazy" alt="modern" src="${esc(r.base)}.modern.png"><i>modern</i></a>
<a href="${esc(r.base)}.old.png"><img loading="lazy" alt="Chromium 106" src="${esc(r.base)}.old.png"><i>Chromium 106</i></a>
<a href="${esc(r.base)}.diff.png"><img loading="lazy" alt="diff" src="${esc(r.base)}.diff.png"><i>diff</i></a>
</div></section>`;
	})
	.join('\n');
const index = results
	.map(
		(r, i) =>
			`<tr><td>${i + 1}</td><td><a href="#${esc(r.base)}">${esc(r.base)}</a></td><td>${pct(r.ratio)}</td><td>${pct(r.strongRatio)}</td><td>${r.heights[0] === r.heights[1] ? r.heights[0] : `<b>${r.heights[0]} vs ${r.heights[1]}</b>`}</td></tr>`,
	)
	.join('\n');
const missing = [
	...onlyModern.map((f) => `only in modern: ${f}`),
	...onlyOld.map((f) => `only in 106: ${f}`),
];
writeFileSync(
	join(reportDir, 'index.html'),
	`<!doctype html><meta charset="utf-8"><title>Modern Chromium vs Chromium 106</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px;background:#f4f4f2;color:#222}
table{border-collapse:collapse;margin-bottom:24px}td,th{padding:2px 12px 2px 0;text-align:left}
section{margin:24px 0}h2{font-size:15px;margin:0 0 6px}.n{font-weight:400;color:#555}
.row{display:flex;gap:8px;align-items:flex-start}.row a{flex:1;min-width:0;display:block;color:#555;text-align:center}
.row img{width:100%;display:block;border:1px solid #bbb;background:#fff}.row i{font-size:12px}
</style>
<h1>Modern Chromium vs Chromium 106</h1>
<p>${results.length} pairs, ranked by changed pixels (threshold 0.1; "strong" is threshold 0.3). Gray padding marks a page of different height.</p>
${missing.length ? `<p><b>Unpaired:</b><br>${missing.map(esc).join('<br>')}</p>` : ''}
<table><tr><th>#</th><th>Picture</th><th>Changed</th><th>Strong</th><th>Height</th></tr>
${index}</table>
${rows}`,
);

console.log(`${results.length} pairs; ${missing.length} unpaired.`);
console.log('\nTop pairs by changed pixels:');
for (const r of results.slice(0, 15))
	console.log(
		`  ${pct(r.ratio).padStart(7)}  strong ${pct(r.strongRatio).padStart(6)}  ${r.base}${
			r.heights[0] !== r.heights[1] ? `  (height ${r.heights[0]} vs ${r.heights[1]})` : ''
		}`,
	);
for (const line of missing) console.log(`  ${line}`);
console.log(`\nReport: ${join(reportDir, 'index.html')}`);
