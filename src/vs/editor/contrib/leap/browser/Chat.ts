import OpenAI from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatCompletionMessageParam } from 'openai/resources';

export interface OpenAIMessage {
	role: "assistant" | "system" | "user";
	content: string;
}

const EOL: string = os.EOL;
const MODEL_CONFIG = {
	model: "gpt-4o-mini",
	// model: "gpt-3.5-turbo-instruct",
	// model: "llama3.1:latest",
	temperature: 0.5,
	n: 5,
	max_tokens: 1024,
	stop: [EOL + EOL],
	stream: true,
	prompt: null,
};

const openAi = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	baseURL: process.env.OPENAI_BASE_URL,
	dangerouslyAllowBrowser: true
});

export async function summarizeConvo(
	convo: ChatCompletionMessageParam[],
	signal: AbortSignal,
	progressCallback?: (e: any) => void
) {
	const prompt: ChatCompletionMessageParam = {
		role: "user",
		content: "Based on the current conversation, explanations requested, and past messages, analyze and summarize the granularity level of explanations that the user prefers, the type of explanations provided (test cases vs. generic), the verbosity required, and the specific topics that the user might require more explanations for in the future. Be as precise as possible, and do not make assumptions. Refer to the user in 3rd person."
	};

	const res = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		messages: convo.concat([prompt]),
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});
	signal.onabort = ((_) => { res.controller.abort(); });
	let response = "";
	for await (const part of res) {
		const delta = part.choices[0].delta.content ?? '';
		response += delta;
		// progressCallback(part);
	}

	return response;
}


export async function getCodeCompletions(prompt: string, signal: AbortSignal, progressCallback: (e: any) => void): Promise<string[]> {
	const completions = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		messages: [
			{
				role: "system",
				content: "You are an expert programmer. You complete the user's code as best as possible. Only output the code that would complete this. Do not repeat the prompt in your answer."
			},
			{
				role: "user",
				content: prompt ?? ""
			}
		],
		temperature: MODEL_CONFIG.temperature,
		// n: MODEL_CONFIG.n,
		// just ask for one completion for now
		n: 1,
		stop: MODEL_CONFIG.stop,
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});

	signal.onabort = ((_) => { completions.controller.abort(); });

	const codes = Array.from({ length: (MODEL_CONFIG.n || 1) }, () => "");
	for await (const part of completions) {
		const i = part.choices[0].index;
		const delta = part.choices[0].delta.content ?? '';
		codes[i] += delta;
		progressCallback(part);
	}

	return cleanUpCompletions(prompt, codes);
}


export async function getOverviewExplanation(
	code: string,
	origPrompt: string,
	signal: AbortSignal,
	progressCallback: (e: any) => void,
	explanationPrefs?: string,
) {
	const messages: ChatCompletionMessageParam[] = [
		{
			role: "system",
			content: "You are an expert Python programmer. You assist the user by completing code and explaining it when necessary. Only provide an explanation of the code you produced. When explaining, provide the level of detail that the user requests for, and do not include the user's prompt. Do not say anything unnecessary."
		},
		{
			role: "user",
			content: origPrompt ?? ""
		},
		{
			role: "assistant",
			content: code
		},
		{
			role: "user",
			content: "Please provide a high-level explaination of what this code does." + (explanationPrefs ? " According to past experience, the user prefers the following type of explanation: " + explanationPrefs : "") + " Only provide an explanation of the codeDo not output my original prompt."
		}
	];
	const completion = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		messages,
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});

	signal.onabort = ((_) => { completion.controller.abort(); });

	let response = "";
	for await (const part of completion) {
		const delta = part.choices[0].delta.content ?? '';
		response += delta;
		progressCallback(part);
	}

	return response;
}

export async function getLineCommentsExplanation(
	code: string,
	origPrompt: string,
	signal: AbortSignal,
	progressCallback: (e: any) => void
) {
	const messages: ChatCompletionMessageParam[] = [
		{
			role: "system",
			content: "You are an expert Python programmer. You assist the user by completing code and explaining it when necessary. Only provide an explanation of the code you produced. When explaining, do not include the user's prompt. Do not say anything unnecessary."
		},
		{
			role: "user",
			content: origPrompt ?? ""
		},
		{
			role: "assistant",
			content: code
		},
		{
			role: "user",
			content: "Please add comments to this code completion explaining the purpose of each line or section. Only output the code completion you provided and the associated comments. Do not output my original prompt."
		}
	];
	const completion = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		messages,
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});
	signal.onabort = ((_) => { completion.controller.abort(); });

	let response = "";
	for await (const part of completion) {
		const delta = part.choices[0].delta.content ?? '';
		response += delta;
		progressCallback(part);
	}

	cleanUpCode(origPrompt, response);

	return response;
}

export async function getTestCasesForCode(
	code: string,
	origPrompt: string,
	signal: AbortSignal,
	progressCallback: (e: any) => void,
	// convo?: ChatCompletionMessageParam[] = []
): Promise<string[]> {
	const completion = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		messages: [
			{
				role: "system",
				content: "You are an expert Python programmer. You provide example test cases that showcase the provide code's functionality. Provide the test cases as `assert` statements in separate code blocks. Do not say anything unnecessary."
			},
			{
				role: "user",
				content: origPrompt + code
			},
		],
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});

	signal.onabort = ((_) => { completion.controller.abort(); });

	let response = "";
	for await (const part of completion) {
		const delta = part.choices[0].delta.content ?? '';
		response += delta;
		progressCallback(part);
	}

	return response.split('```python').slice(1).map((s) => s.split('```')[0]);
}


export async function getConvoResponse(
	message: string,
	convo: ChatCompletionMessageParam[],
	signal: AbortSignal,
	progressCallback: (e: any) => void,
	systemPrompt?: string
) {

	const prompt: ChatCompletionMessageParam = {
		role: "user",
		content: message,
	};

	const res = await openAi.chat.completions.create({
		model: MODEL_CONFIG.model,
		// TODO maybe add system message to convo?
		messages: convo.concat([prompt]),
		max_tokens: MODEL_CONFIG.max_tokens,
		stream: true,
	});

	signal.onabort = ((_) => { res.controller.abort(); });
	let response = "";
	for await (const part of res) {
		const delta = part.choices[0].delta.content ?? '';
		response += delta;
		progressCallback(part);
	}

	return response;
}


function cleanUpCompletions(prompt: string, codes: string[]): string[] {
	for (const i in codes) {
		const completion = codes[i];
		codes[i] = cleanUpCode(prompt ?? "", completion);
	}

	// Remove empty or repeated completions.
	const set = new Set();
	const rs: string[] = [];
	for (const code of codes) {
		if (code === '' || set.has(code)) {
			continue;
		}
		set.add(code);
		rs.push(code);
	}

	return rs;
}

function cleanUpCode(prompt: string, completion: string): string {
	// remove backticks and language part if it exists
	// (assuming language part and actual code is separated by newline)
	completion = completion.trim();
	if (completion.startsWith("```") && completion.endsWith("```")) {
		completion = completion.substring(completion.indexOf("\n"), completion.length - 3);
	}
	completion = completion.trim();

	// from original LEAP stuff
	// The new `instruct` model *tends* to start with '\n' + indentation
	// so we manually remove that here if it matches the end of the prompt
	if (prompt !== null && prompt.length > 1) {
		if (completion.startsWith('\n') && (prompt.endsWith(' ') || prompt.endsWith('\t'))) {
			// Check that the prompt and completion use the same indentation
			const indent_char: string = prompt.at(prompt.length - 1)!;
			if (completion.at(1) !== indent_char) {
				console.warn('Prompt and completion use different indentation characters. Skipping cleanup.');
				return completion;
			}

			completion = completion.substring(1);

			// Find the prompt indent level
			let prompt_indent = 0;
			for (let j = prompt.length - 1; j >= 0; j--) {
				if (prompt.at(j) !== indent_char) {
					prompt_indent = prompt.length - j - 1;
					break;
				}
			}

			// Remove that many indents from the start of the completion
			// First check that this is safe
			let safe = true;
			for (let j = 0; j < prompt_indent; j++) {
				if (!completion.startsWith(indent_char)) {
					safe = false;
					break;
				}
			}

			if (!safe) {
				console.warn('Completion did not have at least the same amount of indentation as the prompt. Skipping cleanup.');
				return completion;
			}

			// We already removed the newline char earlier.
			completion = completion.substring(prompt_indent);
		}
	}

	return completion;
}
