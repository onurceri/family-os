#!/usr/bin/env node
// Lists every distinct `color-mix()` in the built app and extensions with the fallback the build
// wrote for it, as JSON: [{ file, selector?, mix, fallback }]. `fallback` is null where none was
// found. Run after `pnpm build`:
//   node scripts/old-browser/mixes.mjs > mixes.json
// It reads the app's stylesheets, the component styles carried in its JavaScript, and each
// extension package's stylesheet and scripts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '../..');

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(css|js)$/.test(name)) yield path;
	}
}

/** The stylesheets of a built file: the file itself, or the component styles in a script. */
function sheetsOf(path) {
	const text = readFileSync(path, 'utf8');
	if (path.endsWith('.css')) return [text];
	// Svelte writes an injected component style as `{hash:`svelte-…`,code:`…`}`.
	const sheets = [];
	for (const match of text.matchAll(/hash:`svelte-[\w-]+`,code:`((?:[^`\\]|\\.)*)`/g)) {
		sheets.push(match[1].replace(/\\(.)/gs, '$1'));
	}
	return sheets;
}

/**
 * A stylesheet as a tree of blocks: each with its prelude (a selector or an at-rule), its
 * declarations in order and the blocks inside it. Comments and strings are skipped whole.
 */
function parse(css) {
	const top = { prelude: '', declarations: [], children: [] };
	const stack = [top];
	let text = '';
	let depth = 0;
	const flush = () => {
		const at = text.indexOf(':');
		const prop = text.slice(0, at).trim();
		if (at > 0 && /^-{0,2}[a-zA-Z][\w-]*$/.test(prop)) {
			stack.at(-1).declarations.push({ prop, value: text.slice(at + 1).trim() });
		}
		text = '';
	};
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (ch === '/' && css[i + 1] === '*') {
			i = css.indexOf('*/', i + 2) + 1 || css.length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			let end = i + 1;
			while (end < css.length && css[end] !== ch) end += css[end] === '\\' ? 2 : 1;
			text += css.slice(i, end + 1);
			i = end;
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (depth > 0) {
			text += ch;
			continue;
		}
		if (ch === '{') {
			const block = { prelude: text.trim().replace(/\s+/g, ' '), declarations: [], children: [] };
			stack.at(-1).children.push(block);
			stack.push(block);
			text = '';
		} else if (ch === '}') {
			if (text.trim()) flush();
			if (stack.length > 1) stack.pop();
			text = '';
		} else if (ch === ';') flush();
		else text += ch;
	}
	return top;
}

/** The end of the bracketed group that opens at `start` (just past its `)`). */
function closing(text, start) {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return i + 1;
	}
	return text.length;
}

/**
 * Pairs each `color-mix(…)` of a value with what stands in its place in the fallback value (the
 * rest of both is the same). When the two do not line up, the whole values are the pair.
 */
function pairs(mixValue, fallbackValue) {
	const found = [];
	let i = 0;
	let j = 0;
	while (i < mixValue.length) {
		if (mixValue.startsWith('color-mix(', i)) {
			const end = closing(mixValue, i + 'color-mix'.length);
			if (!fallbackValue.startsWith('rgb(', j)) return [[mixValue, fallbackValue]];
			const fallbackEnd = closing(fallbackValue, j + 'rgb'.length);
			found.push([mixValue.slice(i, end), fallbackValue.slice(j, fallbackEnd)]);
			i = end;
			j = fallbackEnd;
		} else if (mixValue[i] === fallbackValue[j]) {
			i++;
			j++;
		} else return [[mixValue, fallbackValue]];
	}
	return j === fallbackValue.length ? found : [[mixValue, fallbackValue]];
}

const isMixSupports = (prelude) => /^@supports\b/.test(prelude) && prelude.includes('color-mix');

const results = new Map();
function record(file, selector, mix, fallback) {
	const key = `${mix}\u0000${fallback}`;
	if (!results.has(key)) results.set(key, { file, ...(selector && { selector }), mix, fallback });
}

/**
 * Walks a list of sibling blocks. A mix sits under `@supports (… color-mix …)`; its fallback is
 * the same property of the same selector in the nearest block before that `@supports`.
 */
function visit(file, blocks) {
	blocks.forEach((block, index) => {
		if (isMixSupports(block.prelude)) {
			for (const rule of block.children) {
				for (const { prop, value } of rule.declarations) {
					if (!value.includes('color-mix(')) continue;
					let fallback = null;
					for (let k = index - 1; k >= 0 && fallback === null; k--) {
						const before = blocks[k];
						if (before.prelude !== rule.prelude) continue;
						const decl = before.declarations.findLast((d) => d.prop === prop);
						if (decl && !decl.value.includes('color-mix(')) fallback = decl.value;
					}
					if (fallback === null) {
						for (const start of mixStarts(value))
							record(file, rule.prelude, value.slice(start, closing(value, start + 9)), null);
					} else {
						for (const [mix, written] of pairs(value, fallback))
							record(file, rule.prelude, mix, written);
					}
				}
			}
			return;
		}
		// A mix outside such an @supports got no fallback from the build.
		for (const { value } of block.declarations) {
			for (const start of mixStarts(value)) {
				record(file, block.prelude, value.slice(start, closing(value, start + 9)), null);
			}
		}
		visit(file, block.children);
	});
}

function mixStarts(value) {
	const starts = [];
	for (let at = value.indexOf('color-mix('); at !== -1; at = value.indexOf('color-mix(', at + 1)) {
		starts.push(at);
	}
	return starts;
}

const places = [
	join(root, 'apps/web/build/_app/immutable'),
	...readdirSync(join(root, 'dist/extensions')).map((id) =>
		join(root, 'dist/extensions', id, 'web'),
	),
];
for (const place of places) {
	for (const path of walk(place)) {
		const file = relative(root, path);
		for (const sheet of sheetsOf(path)) {
			if (sheet.includes('color-mix(')) visit(file, [parse(sheet)]);
		}
	}
}

process.stdout.write(`${JSON.stringify([...results.values()], null, '\t')}\n`);
