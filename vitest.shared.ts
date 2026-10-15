// Test options every project shares. Each project's vitest.config.ts spreads them into its
// `test`, because a project defined in its own file inherits nothing from the root config.
export const testDefaults = {
	// Transformed modules are kept on disk (node_modules/.vitest-cache) and reused by the next
	// run; the cache is keyed by content, so an edited file is transformed again.
	fsModuleCache: true,
	// A fresh worker per test file: files mock modules (vi.mock, vi.stubGlobal) and share
	// module-level state, so each file must start from a clean module graph.
	isolate: true,
} as const;
