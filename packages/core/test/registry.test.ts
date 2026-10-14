import {
	defineAction,
	defineCapability,
	defineExtension,
	type ExtensionManifestInput,
	parseManifest,
	SDK_VERSION,
	satisfiesCaret,
} from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry, orderExtensions } from '../src/registry.ts';
import { defineTestExtension } from './harness.ts';

const ext = (id: string, dependsOn: string[] = [], optional: string[] = []) =>
	defineTestExtension({ id, dependsOn, optional });

const noop = (id: string) =>
	defineAction({
		id,
		title: 't',
		input: z.object({}),
		output: z.object({}),
		readOnly: true,
		run: async () => ({}),
	});

const manifest = (id: string, extra: Partial<ExtensionManifestInput> = {}) => ({
	id,
	version: '1.0.0',
	sdk: `^${SDK_VERSION}`,
	...extra,
});

describe('registry', () => {
	it('orders extensions after their dependencies', () => {
		const ordered = orderExtensions([
			ext('tasks', ['calendar']),
			ext('calendar'),
			ext('inbox', ['tasks']),
		]);
		expect(ordered.map((e) => e.id)).toEqual(['calendar', 'tasks', 'inbox']);
	});

	it('rejects cycles, missing dependencies and duplicates', () => {
		expect(() => orderExtensions([ext('a', ['b']), ext('b', ['a'])])).toThrow(/cycle/);
		expect(() => orderExtensions([ext('a', ['zzz'])])).toThrow(/missing/);
		expect(() => orderExtensions([ext('a'), ext('a')])).toThrow(/Duplicate/);
	});

	it('does without a missing optional dependency, which never changes the order', () => {
		expect(orderExtensions([ext('aa', [], ['bb'])]).map((e) => e.id)).toEqual(['aa']);
		expect(orderExtensions([ext('bb'), ext('aa', [], ['bb'])]).map((e) => e.id)).toEqual([
			'aa',
			'bb',
		]);
		expect(() => orderExtensions([ext('aa', [], ['bb']), ext('bb', [], ['aa'])])).not.toThrow();
	});

	it('rejects contributions outside the extension namespace', () => {
		const action = defineAction({
			id: 'other.doThing',
			title: 't',
			input: z.object({}),
			output: z.object({}),
			run: async () => ({}),
		});
		expect(() => defineTestExtension({ id: 'mine', actions: [action] })).toThrow(/namespaced/);
	});

	it('rejects duplicate action ids across extensions', () => {
		const action = defineAction({
			id: 'a.doThing',
			title: 't',
			input: z.object({}),
			output: z.object({}),
			run: async () => ({}),
		});
		const one = defineTestExtension({ id: 'a', actions: [action] });
		const two = { ...defineTestExtension({ id: 'b' }), actions: [action] };
		expect(() => buildRegistry([one, two])).toThrow(/Duplicate action/);
	});

	it('allows AI hints on read-only actions (read tools) but not on direct changes', () => {
		const view = defineCapability({ id: 'mail.view', label: 'mail:cap', level: 'view' });
		const make = (extra: Record<string, unknown>) =>
			defineAction({
				id: 'mail.look',
				title: 't',
				input: z.object({}),
				output: z.object({}),
				ai: { description: 'looks' },
				run: async () => ({}),
				...extra,
			});
		const build = (action: ReturnType<typeof make>) =>
			buildRegistry([defineTestExtension({ id: 'mail', capabilities: [view], actions: [action] })]);
		expect(() => build(make({ readOnly: true, requires: view.id }))).not.toThrow();
		expect(() => build(make({ requires: view.id, approval: 'never' }))).toThrow(
			/would apply AI changes directly/,
		);
		expect(() => build(make({ readOnly: true, requires: view.id, external: true }))).toThrow(
			/external and cannot have AI hints/,
		);
	});

	it('refuses AI hints on an action that sends data outside', () => {
		const manage = defineCapability({ id: 'mail.manage', label: 'mail:cap', level: 'manage' });
		const send = (ai: boolean) =>
			defineAction({
				id: 'mail.sendNote',
				title: 't',
				input: z.object({}),
				output: z.object({}),
				approval: 'always',
				requires: manage.id,
				external: true,
				...(ai && { ai: { description: 'Sends a note' } }),
				run: async () => ({}),
			});
		expect(() =>
			buildRegistry([
				defineTestExtension({ id: 'mail', capabilities: [manage], actions: [send(true)] }),
			]),
		).toThrow(/external and cannot have AI hints/);
		expect(() =>
			buildRegistry([
				defineTestExtension({ id: 'mail', capabilities: [manage], actions: [send(false)] }),
			]),
		).not.toThrow();
	});
});

describe('manifest', () => {
	const view = defineCapability({ id: 'mail.view', label: 'mail:cap', level: 'view' });
	const edit = defineCapability({ id: 'mail.edit', label: 'mail:cap', level: 'edit' });

	it('refuses a malformed manifest, naming the extension and the field', () => {
		expect(() => parseManifest({ id: 'mail', version: '1.0', sdk: '^0.1.0' })).toThrow(
			/"mail".*version/,
		);
		expect(() => parseManifest({ id: 'mail', version: '1.0.0', sdk: '>=0.1.0' })).toThrow(/sdk/);
		expect(() => parseManifest({ id: 'Mail', version: '1.0.0', sdk: '^0.1.0' })).toThrow(/id/);
		expect(() => parseManifest({ ...manifest('mail'), surprise: true })).toThrow(/surprise/);
		expect(parseManifest(manifest('mail'))).toMatchObject({
			dependsOn: [],
			optional: [],
			capabilities: [],
			calls: [],
		});
	});

	it('reads caret ranges as npm does', () => {
		expect(satisfiesCaret('1.4.0', '^1.2.3')).toBe(true);
		expect(satisfiesCaret('1.2.3', '^1.2.3')).toBe(true);
		expect(satisfiesCaret('1.2.2', '^1.2.3')).toBe(false);
		expect(satisfiesCaret('2.0.0', '^1.2.3')).toBe(false);
		expect(satisfiesCaret('0.2.5', '^0.2.3')).toBe(true);
		expect(satisfiesCaret('0.3.0', '^0.2.3')).toBe(false);
		expect(satisfiesCaret('0.0.3', '^0.0.3')).toBe(true);
		expect(satisfiesCaret('0.0.4', '^0.0.3')).toBe(false);
		expect(satisfiesCaret('1.2.3', '1.2.3')).toBe(false);
		expect(satisfiesCaret(SDK_VERSION, `^${SDK_VERSION}`)).toBe(true);
	});

	it('refuses an extension carrying the manifest of another', () => {
		const mail = defineExtension({ manifest: manifest('mail') });
		const swapped = { ...mail, manifest: parseManifest(manifest('post')) };
		expect(() => buildRegistry([swapped])).toThrow(/manifest of "post"/);
	});

	it('refuses an extension built for another SDK', () => {
		const [major] = SDK_VERSION.split('.').map(Number) as [number];
		const later = defineExtension({ manifest: manifest('mail', { sdk: `^${major + 1}.0.0` }) });
		expect(() => buildRegistry([later])).toThrow(/needs SDK/);
	});

	it('refuses capabilities that the code and the manifest disagree on', () => {
		const build = (listed: string[]) =>
			buildRegistry([
				defineExtension({
					manifest: manifest('mail', { capabilities: listed }),
					capabilities: [view, edit],
				}),
			]);
		expect(() => build(['mail.view', 'mail.edit'])).not.toThrow();
		expect(() => build(['mail.view'])).toThrow(/manifest lacks: mail\.edit/);
		expect(() => build(['mail.view', 'mail.edit', 'mail.manage'])).toThrow(
			/code lacks: mail\.manage/,
		);
	});

	it('refuses overlapping table prefixes', () => {
		const home = defineExtension({ manifest: manifest('home') });
		const helper = defineExtension({ manifest: manifest('helper', { tablePrefix: 'home_' }) });
		const nested = defineExtension({ manifest: manifest('hub', { tablePrefix: 'home_hub_' }) });
		const apart = defineExtension({ manifest: manifest('hub', { tablePrefix: 'hub_x_' }) });
		expect(() => buildRegistry([home, helper])).toThrow(/overlapping table prefixes/);
		expect(() => buildRegistry([home, nested])).toThrow(/overlapping table prefixes/);
		expect(() => buildRegistry([home, apart])).not.toThrow();
		expect(() => parseManifest(manifest('hub', { tablePrefix: 'hub' }))).toThrow(/tablePrefix/);
	});

	it('allows calls only to actions of core, a dependency or an optional extension', () => {
		const records = defineExtension({
			manifest: manifest('records'),
			actions: [noop('records.attach')],
		});
		const caller = (extra: Partial<ExtensionManifestInput>) =>
			defineExtension({ manifest: manifest('mail', extra) });

		expect(() =>
			buildRegistry([records, caller({ dependsOn: ['records'], calls: ['records.attach'] })]),
		).not.toThrow();
		expect(() =>
			buildRegistry([records, caller({ optional: ['records'], calls: ['records.attach'] })]),
		).not.toThrow();
		// An optional extension that is not installed: nothing to check its calls against.
		expect(() =>
			buildRegistry([caller({ optional: ['records'], calls: ['records.attach'] })]),
		).not.toThrow();
		expect(() => buildRegistry([records, caller({ calls: ['records.attach'] })])).toThrow(
			/neither a dependency nor optional/,
		);
		expect(() =>
			buildRegistry([records, caller({ dependsOn: ['records'], calls: ['records.detach'] })]),
		).toThrow(/does not have/);
		expect(() =>
			buildRegistry([
				defineExtension({
					manifest: manifest('mail', { calls: ['mail.look'] }),
					actions: [noop('mail.look')],
				}),
			]),
		).toThrow(/its own action/);
		const core = defineExtension({ manifest: manifest('core'), actions: [noop('core.recall')] });
		expect(() => buildRegistry([core, caller({ calls: ['core.recall'] })])).not.toThrow();
		expect(() => buildRegistry([core, caller({ calls: ['core.forget'] })])).toThrow(
			/does not have/,
		);
	});

	it('refuses an extension named both as a dependency and as optional', () => {
		expect(() =>
			buildRegistry([
				defineExtension({ manifest: manifest('records') }),
				defineExtension({
					manifest: manifest('mail', { dependsOn: ['records'], optional: ['records'] }),
				}),
			]),
		).toThrow(/both as a dependency and as optional/);
	});
});
