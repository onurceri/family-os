// The names a package and its archive agree on. They live apart from the build so that the
// scripts that only pack, sign and index archives do not load Vite, Svelte and Tailwind.

/** The version of the package format, so a host can refuse one it does not understand. */
export const PACKAGE_FORMAT = 1;

/** The file that describes a built package; every other file is listed in it with its hash. */
export const PACKAGE_FILE = 'famos-package.json';
