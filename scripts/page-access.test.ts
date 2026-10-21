import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A page says who may open it with `requires`, and its navigation entry says who sees the way to
 * it. The two must agree, or a page hidden from someone's menu still opens from a typed address
 * (and fails on every read), or a page they may open has no way to it. This reads every
 * extension's `./web` entry and checks each page against its entry: the one on the same path, or
 * else the one whose path the page lies under (`/vehicles/:id` under `/vehicles`).
 *
 * The app's own settings pages need no check: their settings entry is their declaration
 * (`APP_SETTINGS` in `apps/web/src/lib/nav.ts`). So they must not keep people out by hand either.
 */
const root = join(import.meta.dirname, '..');
const extensions = readdirSync(join(root, 'extensions')).filter((name) =>
	existsSync(join(root, 'extensions', name, 'src/web/index.ts')),
);

interface Declared {
	id: string;
	path: string;
	requires: string | undefined;
}

/** The string constants a file declares (`const SETTINGS_PATH = '…'`), with those it imports. */
function constants(file: string, seen = new Set<string>()): Map<string, string> {
	const found = new Map<string, string>();
	if (seen.has(file) || !existsSync(file)) return found;
	seen.add(file);
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const d of statement.declarationList.declarations) {
				if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer))
					found.set(d.name.text, d.initializer.text);
			}
		} else if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text.startsWith('.')
		) {
			const target = resolve(dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
			for (const [name, value] of constants(target, seen)) found.set(name, value);
		}
	}
	return found;
}

/** The entries of the `nav` and `pages` arrays of an extension's `./web` entry. */
function declared(ext: string): { nav: Declared[]; pages: Declared[] } {
	const file = join(root, 'extensions', ext, 'src/web/index.ts');
	const known = constants(file);
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
	const text = (node: ts.Expression | undefined): string | undefined => {
		if (!node) return undefined;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isIdentifier(node)) {
			const value = known.get(node.text);
			if (value === undefined) throw new Error(`${ext}: cannot read the value of ${node.text}`);
			return value;
		}
		throw new Error(`${ext}: write \`path\` and \`requires\` as strings or constants`);
	};
	const property = (object: ts.ObjectLiteralExpression, name: string) => {
		const p = object.properties.find(
			(p): p is ts.PropertyAssignment =>
				ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
		);
		return p?.initializer;
	};
	const entry = (object: ts.ObjectLiteralExpression): Declared => ({
		id: text(property(object, 'id')) ?? '?',
		path: text(property(object, 'path')) ?? '?',
		requires: text(property(object, 'requires')),
	});
	const objects = (node: ts.Expression | undefined) =>
		node && ts.isArrayLiteralExpression(node)
			? node.elements.filter(ts.isObjectLiteralExpression)
			: [];

	const nav: Declared[] = [];
	const pages: Declared[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'defineWebExtension'
		) {
			const definition = node.arguments[0];
			if (definition && ts.isObjectLiteralExpression(definition)) {
				for (const n of objects(property(definition, 'nav'))) {
					nav.push(entry(n));
					for (const child of objects(property(n, 'children'))) nav.push(entry(child));
				}
				for (const p of objects(property(definition, 'pages'))) pages.push(entry(p));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { nav, pages };
}

/** The entry a page belongs to: on its path, or the longest one it lies under. */
function entryOf(page: Declared, nav: Declared[]): Declared | undefined {
	return nav
		.filter((n) => page.path === n.path || page.path.startsWith(`${n.path}/`))
		.toSorted((a, b) => b.path.length - a.path.length)[0];
}

describe('page access', () => {
	it('reads the pages of every extension', () => {
		const pages = extensions.flatMap((ext) => declared(ext).pages);
		expect(pages.length).toBeGreaterThan(10);
		expect(pages.every((p) => p.path.startsWith('/'))).toBe(true);
	});

	it('gives every page the `requires` of its navigation entry', () => {
		const mismatches = extensions.flatMap((ext) => {
			const { nav, pages } = declared(ext);
			return pages.flatMap((page) => {
				const owner = entryOf(page, nav);
				if (!owner || owner.requires === page.requires) return [];
				return [
					`${page.id} (${page.path}) requires ${page.requires ?? 'nothing'}, its entry ${owner.id} (${owner.path}) ${owner.requires ?? 'nothing'}`,
				];
			});
		});
		expect(mismatches).toEqual([]);
	});

	it('leaves keeping people out of an app page to the shell', () => {
		const dir = join(root, 'apps/web/src/routes/settings');
		const offenders = (readdirSync(dir, { recursive: true }) as string[])
			.filter((f) => f.endsWith('.svelte'))
			.filter((f) =>
				/goto\('\/',\s*\{\s*replace:\s*true\s*\}\)/.test(readFileSync(join(dir, f), 'utf8')),
			);
		expect(offenders, 'give the page `requires` in APP_SETTINGS instead').toEqual([]);
	});

	it("keeps Today's suggestions card to people who may read the suggestions list", () => {
		// The card loads `/core/drafts`, a route that needs `core.drafts.propose`; without the
		// same `requires` on the card, a role holding only `core.drafts.waiting` meets two 403s.
		const index = readFileSync(join(root, 'extensions/inbox/src/web/index.ts'), 'utf8');
		const card = /slot: 'dashboard\.card',\s*id: 'inbox\.waiting',[^}]*?requires: '([^']+)'/.exec(
			index,
		);
		expect(card?.[1]).toBe('core.drafts.propose');
	});
});
