/**
 * Whether a model is known to fail while the family limits OpenRouter to providers that keep no
 * data: the connection test listed which models have such a provider, and this one is not among
 * them. Unknown (no list, or the option is off) is never a warning.
 */
export function needsAnyProvider(
	model: string,
	zeroRetentionModels: ReadonlySet<string> | undefined,
	zeroRetention: boolean,
): boolean {
	const id = model.trim();
	return (
		zeroRetention && zeroRetentionModels !== undefined && id !== '' && !zeroRetentionModels.has(id)
	);
}
