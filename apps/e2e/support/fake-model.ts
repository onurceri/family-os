import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * What Quick add expects from a model: a label, what the item is, and the things it states as
 * mentions of the kinds the installed extensions offer (names as names, days as words).
 */
export interface ModelAnswer {
	label: string;
	intent: 'actionable' | 'nothing' | 'question';
	mentions: ({ kind: string } & Record<string, unknown>)[];
}

/** One round trip of the assistant's tool loop: call a tool, or answer in text. */
export type ChatRound =
	| { tool: string; input?: unknown }
	/** `slowMs` pauses between words, so a test can watch the answer grow. */
	| { text: string; slowMs?: number };

/**
 * A stand-in OpenAI-compatible server, so E2E runs never call a real provider. Answers are
 * queued by the test (`answer(...)`); without one, it answers "nothing to do".
 */
export async function startFakeModel() {
	const queue: ModelAnswer[] = [];
	const prompts: string[] = [];
	const rounds: ChatRound[] = [];
	/** The body of every streamed chat request (the assistant), as the model receives it. */
	const chatRequests: {
		messages: { role: string; content?: unknown }[];
		tools?: { function: { name: string } }[];
	}[] = [];
	/** The texts of every embeddings request (family search), in order. */
	const embeddingInputs: string[][] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			res.setHeader('content-type', 'application/json');
			if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
			if (req.url?.endsWith('/embeddings')) {
				const input = (JSON.parse(raw || '{}') as { input?: string[] }).input ?? [];
				embeddingInputs.push(input);
				return res.end(
					JSON.stringify({
						object: 'list',
						model: 'fake-embed',
						data: input.map((text, index) => ({
							object: 'embedding',
							index,
							embedding: embeddingOf(text),
						})),
						usage: { prompt_tokens: input.length, total_tokens: input.length },
					}),
				);
			}
			const body = JSON.parse(raw || '{}') as {
				messages?: { role: string; content?: unknown }[];
				tools?: { function: { name: string } }[];
				stream?: boolean;
			};
			if (body.stream) {
				chatRequests.push({
					messages: body.messages ?? [],
					...(body.tools && { tools: body.tools }),
				});
				return void streamRound(res, rounds.shift() ?? { text: 'OK' });
			}
			prompts.push(JSON.stringify(body.messages ?? []));
			const answer = queue.shift() ?? { label: 'Nothing to do', intent: 'nothing', mentions: [] };
			res.end(
				JSON.stringify({
					id: 'fake',
					object: 'chat.completion',
					created: 1,
					model: 'fake',
					choices: [
						{
							index: 0,
							finish_reason: 'stop',
							message: { role: 'assistant', content: JSON.stringify(answer) },
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		answer: (...answers: ModelAnswer[]) => void queue.push(...answers),
		/** Queues the rounds of assistant chats, one per streamed request, in order. */
		chat: (...next: ChatRound[]) => void rounds.push(...next),
		chatRequests,
		embeddingInputs,
		/** Every request's messages, as JSON. */
		prompts,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Dimensions of the stand-in embedding model. */
const EMBEDDING_DIMENSIONS = 64;

/**
 * A hashed bag of words: texts that share words get similar vectors, deterministically, so a
 * test can expect which record a question finds without a real embedding model.
 */
function embeddingOf(text: string): number[] {
	const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
	for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		let hash = 2166136261;
		for (const ch of word) hash = Math.imul(hash ^ (ch.codePointAt(0) ?? 0), 16777619);
		const slot = (hash >>> 0) % EMBEDDING_DIMENSIONS;
		vector[slot] = (vector[slot] ?? 0) + 1;
	}
	return vector;
}

export type FakeModel = Awaited<ReturnType<typeof startFakeModel>>;

/** Answers one streamed chat completion: a tool call or text, then the usage block. */
async function streamRound(res: http.ServerResponse, round: ChatRound) {
	const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
		`data: ${JSON.stringify({
			id: 'fake',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'fake',
			choices: [{ index: 0, delta, finish_reason: finish }],
			...extra,
		})}\n\n`;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if ('tool' in round) {
		res.write(
			chunk(
				{
					role: 'assistant',
					tool_calls: [
						{
							index: 0,
							id: `call_${Math.random().toString(36).slice(2)}`,
							type: 'function',
							function: { name: round.tool, arguments: JSON.stringify(round.input ?? {}) },
						},
					],
				},
				null,
			),
		);
		res.write(chunk({}, 'tool_calls'));
	} else {
		const pieces = round.text.match(/\S+\s*/g) ?? [round.text];
		for (const [i, piece] of pieces.entries()) {
			res.write(chunk(i === 0 ? { role: 'assistant', content: piece } : { content: piece }, null));
			if (round.slowMs) await new Promise((resolve) => setTimeout(resolve, round.slowMs));
		}
		res.write(chunk({}, 'stop'));
	}
	res.write(
		`data: ${JSON.stringify({
			id: 'fake',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'fake',
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		})}\n\n`,
	);
	res.end('data: [DONE]\n\n');
}
