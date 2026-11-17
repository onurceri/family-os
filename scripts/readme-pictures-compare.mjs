// Which README pictures really changed (.github/workflows/readme-pictures.yml): pure comparison
// logic, plus `settle`, which puts back every picture that differs from the committed one only by noise.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const IMAGES = 'docs/images';

/**
 * A picture changed when more than this share of its pixels differ by more than the tolerance in
 * a channel. Making a picture again from an unchanged UI still moves a board note's tilt (from
 * its random id), anti-aliased edges and compression noise: two runs on one day differed by up to
 * 0.26% of the pixels of the widest picture at a tolerance of 24, so the line sits at twice that.
 * A changed layout, colour, icon or a few words moves more.
 */
export const CHANGED_SHARE = 0.005;
export const CHANNEL_TOLERANCE = 24;

/** What can change a picture: the UI, its words and themes, and the sweep that takes them. */
const PICTURE_INPUTS = [
	/^apps\/web\//,
	/^packages\/ui\//,
	/^packages\/themes\//,
	/^themes\//,
	/^languages\//,
	/^extensions\/[^/]+\/src\/web\//,
	/^extensions\/[^/]+\/src\/messages\//,
	/^apps\/e2e\/sweep\//,
	/^apps\/e2e\/support\//,
	/^apps\/e2e\/readme\.config\.ts$/,
	/^README\.md$/,
	/^docs\/images\//,
	/^\.github\/workflows\/readme-pictures\.yml$/,
];

/** True when any of `paths` can change a picture of the README. */
export const affectsPictures = (paths) =>
	paths.some((path) => PICTURE_INPUTS.some((pattern) => pattern.test(path)));

/** The size and RGB bytes of a binary PPM (`dwebp -ppm`). */
export function readPpm(buffer) {
	let at = 0;
	const space = (byte) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
	const token = () => {
		while (space(buffer[at])) at++;
		const start = at;
		while (at < buffer.length && !space(buffer[at])) at++;
		return buffer.toString('latin1', start, at);
	};
	if (token() !== 'P6') throw new Error('Not a binary PPM');
	const width = Number(token());
	const height = Number(token());
	token(); // the maximum value
	at++; // the one whitespace byte before the pixels
	return { width, height, pixels: buffer.subarray(at, at + width * height * 3) };
}

/** The share (0 to 1) of pixels that differ by more than `tolerance` in any channel; 1 when the sizes differ. */
export function changedShare(a, b, tolerance = CHANNEL_TOLERANCE) {
	if (a.width !== b.width || a.height !== b.height) return 1;
	const total = a.width * a.height;
	let changed = 0;
	for (let i = 0; i < total; i++) {
		const at = i * 3;
		if (
			Math.abs(a.pixels[at] - b.pixels[at]) > tolerance ||
			Math.abs(a.pixels[at + 1] - b.pixels[at + 1]) > tolerance ||
			Math.abs(a.pixels[at + 2] - b.pixels[at + 2]) > tolerance
		)
			changed++;
	}
	return total === 0 ? 0 : changed / total;
}

/** True when the two decoded pictures differ by more than noise. */
export const pictureChanged = (a, b) => changedShare(a, b) > CHANGED_SHARE;

/** Puts back each modified picture that is only noise against the committed one; returns what it kept and restored. */
export function settlePictures() {
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
	const modified = git('diff', '--name-only', '--', IMAGES)
		.split('\n')
		.filter((path) => path.endsWith('.webp'));
	const dir = mkdtempSync(join(tmpdir(), 'readme-pictures-'));
	const kept = [];
	const restored = [];
	// Decoded into the temporary folder, never next to the pictures (they would be committed).
	const decode = (file) => {
		const out = join(dir, 'decoded.ppm');
		execFileSync('dwebp', ['-quiet', '-ppm', file, '-o', out]);
		return readPpm(readFileSync(out));
	};
	try {
		for (const path of modified) {
			const committed = join(dir, 'committed.webp');
			writeFileSync(
				committed,
				execFileSync('git', ['show', `HEAD:${path}`], { maxBuffer: 1 << 26 }),
			);
			const share = changedShare(decode(committed), decode(path));
			if (share > CHANGED_SHARE) kept.push({ path, share });
			else {
				git('checkout', '--', path);
				restored.push({ path, share });
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return { kept, restored };
}

/** Whether a path that can change a picture differs between two commits. */
export const pictureInputsChanged = (base, head) =>
	affectsPictures(
		execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' })
			.split('\n')
			.filter(Boolean),
	);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [command, ...rest] = process.argv.slice(2);
	const option = (name) => rest[rest.indexOf(`--${name}`) + 1];
	if (command === 'settle') {
		const { kept, restored } = settlePictures();
		const percent = ({ share }) => `${(share * 100).toFixed(3)}%`;
		for (const picture of restored) console.log(`unchanged ${picture.path} (${percent(picture)})`);
		for (const picture of kept) console.log(`changed ${picture.path} (${percent(picture)})`);
	} else if (command === 'needed' && option('base') && option('head')) {
		console.log(String(pictureInputsChanged(option('base'), option('head'))));
	} else {
		console.error(
			'Usage: node scripts/readme-pictures-compare.mjs settle | needed --base <ref> --head <ref>',
		);
		process.exit(2);
	}
}
