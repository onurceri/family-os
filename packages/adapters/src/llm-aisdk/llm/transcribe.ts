import { LlmError, type LlmTranscribeRequest, type LlmTranscribeResult } from '@famos/sdk';
import { aiTables } from '../tables.ts';
import { type AiSdkLlmDeps, type LlmCalls, within } from './calls.ts';
import { providerReasonOf, toLlmError } from './errors.ts';

/** Maps an HTTP status of a speech-to-text call to the error codes of the port. */
function statusToLlmError(status: number, body: string): LlmError {
	if (status === 401 || status === 403)
		return new LlmError('auth', 'The provider refused the API key');
	if (status === 402) return new LlmError('limit_reached', 'The provider account is out of credit');
	if (status === 404)
		return new LlmError(
			'not_configured',
			'The provider has no speech-to-text endpoint or model for this name',
		);
	if (status === 400 || status === 413 || status === 415 || status === 422) {
		return new LlmError(
			'rejected',
			`The provider rejected the audio (HTTP ${status}) ${providerReasonOf(body) ?? ''}`.trim(),
		);
	}
	return new LlmError('unavailable', `The provider is unavailable (HTTP ${status})`);
}

/** `transcribe`: speech to text through the provider's `/audio/transcriptions`. */
export function createTranscribe(deps: AiSdkLlmDeps, calls: LlmCalls) {
	const { logger, checkLimits, checkAreas, target, policy } = calls;

	return {
		async transcribe(request: LlmTranscribeRequest): Promise<LlmTranscribeResult> {
			const allowed = await policy(request.feature, 'transcribe');
			if (!allowed.enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			if (!allowed.sendVoice) throw new LlmError('disabled', 'Voice notes are not sent to the AI');
			const { role, provider } = await target('transcribe');
			if (provider.kind === 'ollama') {
				throw new LlmError(
					'not_configured',
					'Ollama has no speech-to-text endpoint; choose another provider for this role',
				);
			}

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = async (fields: { cost?: number | null; errorCode?: string | null }) => {
				await aiTables(deps.db)
					.insertInto('ai_usage')
					.values({
						id: deps.ids.next('ai_call'),
						at: started,
						role: 'transcribe',
						provider_id: provider.id,
						model: label,
						feature: request.feature,
						member_id: request.memberId ?? null,
						job_id: request.jobId ?? null,
						input_tokens: null,
						output_tokens: null,
						cost_micros: fields.cost == null ? null : Math.round(fields.cost * 1_000_000),
						latency_ms: Math.max(0, deps.clock.now() - started),
						error_code: fields.errorCode ?? null,
						areas: JSON.stringify([...new Set(request.areas)]),
					})
					.execute();
			};

			try {
				await checkAreas(request.areas, provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error, role.model);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			// What the provider says the call cost, also when its answer holds no transcript.
			let cost: number | null = null;
			try {
				const form = new FormData();
				form.append(
					'file',
					new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: request.mediaType }),
					request.filename,
				);
				form.append('model', role.model);
				form.append('response_format', 'json');
				if (request.language) form.append('language', request.language);
				const response = await (deps.fetch ?? fetch)(`${provider.baseUrl}/audio/transcriptions`, {
					method: 'POST',
					headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
					body: form,
					signal: within(request.timeoutMs, request.signal),
				});
				if (!response.ok) throw statusToLlmError(response.status, await response.text());
				const body = (await response.json().catch(() => null)) as {
					text?: unknown;
					usage?: { cost?: unknown };
				} | null;
				const reported = body?.usage?.cost;
				cost = typeof reported === 'number' ? reported : null;
				if (typeof body?.text !== 'string') {
					throw new LlmError('invalid_output', 'The provider did not return a transcript');
				}
				await record({ cost });
				return {
					text: body.text.trim(),
					model: label,
					usage: { inputTokens: null, outputTokens: null, cost },
				};
			} catch (error) {
				const failure = toLlmError(error, role.model);
				await record({ errorCode: failure.code, cost });
				logger.warn(
					{
						feature: request.feature,
						role: 'transcribe',
						model: label,
						code: failure.code,
						reason: failure.message.slice(0, 300),
					},
					'transcription failed',
				);
				throw failure;
			}
		},
	};
}
