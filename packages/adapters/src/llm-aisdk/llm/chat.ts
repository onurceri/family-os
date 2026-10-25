import { type LlmChatRequest, type LlmChatResult, LlmError } from '@famos/sdk';
import { isStepCount, jsonSchema, type ModelMessage, streamText, tool } from 'ai';
import { type AiSdkLlmDeps, type LlmCalls, within } from './calls.ts';
import { toLlmError } from './errors.ts';

/**
 * The share of a chat's time limit after which the model gets no more tools: what is left is
 * for the answer, so a slow tool loop ends with one instead of a timeout.
 */
export const ANSWER_BY_SHARE = 0.6;

/** Chat messages as the AI SDK wants them. A tool result is preceded by the call it answers. */
function toModelMessages(messages: LlmChatRequest['messages']): ModelMessage[] {
	return messages.flatMap((m, i): ModelMessage[] => {
		if (m.role !== 'tool') return [{ role: m.role, content: m.content }];
		const toolCallId = m.toolCallId ?? `call_${i}`;
		const toolName = m.toolName ?? 'tool';
		return [
			{ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: {} }] },
			{
				role: 'tool',
				content: [
					{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: m.content } },
				],
			},
		];
	});
}

/** `chat`: a streamed answer with a loop of tool calls. */
export function createChat(deps: AiSdkLlmDeps, calls: LlmCalls) {
	const { factory, logger, checkLimits, checkAreas, target, recorder, policy } = calls;

	return {
		async chat(request: LlmChatRequest): Promise<LlmChatResult> {
			if (!(await policy(request.feature, request.role)).enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			const { role, provider } = await target(request.role);

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = recorder(request, provider.id, label, started);
			try {
				await checkAreas(request.areas, provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error, role.model);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			// Wall time, like the abort signal that ends the loop (the clock may be a test's).
			const began = performance.now();
			const calls: { name: string; ok: boolean }[] = [];
			const tools = Object.fromEntries(
				request.tools.map((t) => [
					t.name,
					tool({
						description: t.description,
						inputSchema: jsonSchema(t.inputSchema),
						async execute(input: unknown) {
							request.onToolCall?.(t.name, input);
							try {
								const result = await t.execute(input);
								calls.push({ name: t.name, ok: true });
								request.onToolResult?.(t.name, true);
								return typeof result === 'string' ? result : JSON.stringify(result ?? null);
							} catch (error) {
								// The model sees that the call failed and why, and can recover or say so.
								calls.push({ name: t.name, ok: false });
								request.onToolResult?.(t.name, false);
								return `Error: ${error instanceof Error ? error.message : 'the tool failed'}`;
							}
						},
					}),
				]),
			);

			// What the finished steps used, kept outside the loop so a call that fails after a step
			// still records the tokens and cost that step was charged.
			let input: number | null = null;
			let output: number | null = null;
			let cost: number | null = null;
			let finishReason: string | null = null;
			const spent = () => cost ?? (provider.kind === 'ollama' ? 0 : null);
			try {
				const result = streamText({
					model: factory(provider, role.model),
					...(request.system && { system: request.system }),
					messages: toModelMessages(request.messages),
					tools,
					...(request.temperature !== undefined && { temperature: request.temperature }),
					stopWhen: isStepCount(Math.max(1, request.maxSteps)),
					// Once the host closes the tools, the next step can only be the answer. So is the
					// last step, and any step once most of the time is gone: a model still calling
					// tools then ends with what it found, not with no answer or a timeout.
					prepareStep: ({ stepNumber }) =>
						request.toolsClosed?.() ||
						stepNumber >= request.maxSteps - 1 ||
						performance.now() - began > request.timeoutMs * ANSWER_BY_SHARE
							? { toolChoice: 'none' as const }
							: {},
					providerOptions: { openaiCompatible: { strictJsonSchema: false } },
					maxRetries: 1,
					abortSignal: within(request.timeoutMs, request.signal),
				});
				let text = '';
				let stepStart = true;
				for await (const part of result.fullStream) {
					if (part.type === 'error') throw part.error;
					// The time limit of the whole loop ran out.
					if (part.type === 'abort')
						throw new DOMException('The model did not answer in time', 'TimeoutError');
					// A call the loop could not run: a tool that was not offered, or input that does not
					// fit its schema. The model is told and may recover; the log says which (no input).
					if (part.type === 'tool-error') {
						calls.push({ name: part.toolName, ok: false });
						logger.warn(
							{
								feature: request.feature,
								model: label,
								tool: part.toolName,
								offered: part.toolName in tools,
								reason: String((part.error as Error)?.message ?? part.error).slice(0, 200),
							},
							'tool call failed',
						);
					}
					if (part.type === 'start-step') stepStart = text.length > 0;
					if (part.type === 'text-delta' && part.text) {
						// Text of a later step (after tool calls) continues the answer in a new paragraph.
						const delta = stepStart ? `\n\n${part.text}` : part.text;
						stepStart = false;
						text += delta;
						request.onText?.(delta);
					}
					if (part.type === 'finish-step') {
						if (part.usage.inputTokens != null) input = (input ?? 0) + part.usage.inputTokens;
						if (part.usage.outputTokens != null) output = (output ?? 0) + part.usage.outputTokens;
						const reported = (part.providerMetadata?.famos as { cost?: number } | undefined)?.cost;
						if (typeof reported === 'number') cost = (cost ?? 0) + reported;
						finishReason = part.finishReason;
					}
					if (part.type === 'finish') finishReason = part.finishReason;
				}
				const usage = { inputTokens: input, outputTokens: output, cost: spent() };
				await record({ input, output, cost: usage.cost, finishReason });
				return { text: text.trim(), toolCalls: calls, model: label, usage };
			} catch (error) {
				const failure = toLlmError(error, role.model);
				// Before any step finished nothing was charged, not even the zero of a local model.
				await record({
					errorCode: failure.code,
					input,
					output,
					cost: finishReason === null ? null : spent(),
					finishReason,
				});
				logger.warn(
					{
						feature: request.feature,
						role: request.role,
						model: label,
						code: failure.code,
						reason: failure.message.slice(0, 300),
					},
					'model call failed',
				);
				throw failure;
			}
		},
	};
}
