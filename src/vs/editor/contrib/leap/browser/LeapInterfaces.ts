import { ICodeEditor } from "vs/editor/browser/editorBrowser";
import { IPosition } from "vs/editor/common/core/position";
import { ALogger, StudyGroup } from "../../rtv/browser/RTVInterfaces";

// Our internal type for OpenAI requests, used for both
// remote and local versions.
export interface OpenAIRequest {
	model: string;
	messages?: OpenAIMessage[];
	prompt: string | null;
	suffix?: string;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	n?: number;
	stream: true;
	logprobs?: number;
	echo?: boolean;
	stop?: string | string[];
	presence_penalty?: number;
	frequency_penalty?: number;
	best_of?: number;
	user?: string;
}

export interface OpenAIMessage {
	role: "assistant" | "system" | "user";
	content: string;
}

export { StudyGroup } from "../../rtv/browser/RTVInterfaces";

export interface ILeapUtils {
	readonly EOL: string;
	getCompletions(request: OpenAIRequest, signal: AbortSignal, progressCallback: (e: any) => void): Promise<string[]>;
	buildRequest(prefix: string, suffix: string): Promise<OpenAIRequest>;
	getConfig(): Promise<LeapConfig>;
	getLogger(editor: ICodeEditor): ILeapLogger;
}

export abstract class ALeapUtils implements ILeapUtils {
	abstract EOL: string;
	abstract getCompletions(request: OpenAIRequest, signal: AbortSignal, progressCallback: (e: any) => void): Promise<string[]>;
	abstract buildRequest(prefix: string, suffix: string): Promise<OpenAIRequest>;
	abstract getConfig(): Promise<LeapConfig>;
	abstract getLogger(editor: ICodeEditor): ILeapLogger;

	createPromptFromTemplate(prompt_text: string, substitutions: { [key: string]: string }): OpenAIMessage[] {
		/**
		 * 1. Parse the prompt text.
		 * 2. Substitute all words in the text file of {{key}} to the value at substitutions[key].
		 * 3. Generate a message list for use with the OpenAI API.
		 */

		const sections = prompt_text.split('---\n');
		const chatText: OpenAIMessage[] = [];

		for (const section of sections) {
			const sectionLines = section.split('\n');
			const role = sectionLines[0];
			let content = sectionLines.slice(1).join('\n');

			for (const [key, value] of Object.entries(substitutions)) {
				content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
			}

			const hasMustaches =
				content.includes('{{') && content.includes('}}');

			if (hasMustaches) {
				throw new Error(`Mustache brackets were not replaced in prompt text:\n${content}`);
			}
			if (role !== 'system' && role !== 'user' && role !== 'assistant') {
				throw new Error(`Role is not 'system', 'user', or 'assistant'. It is '${role}'.`);
			}

			chatText.push({
				role,
				content,
			});
		}
		return chatText;
	}

	cleanUpCompletions(request: OpenAIRequest, codes: string[]): string[] {
		const prompt = request.prompt;

		for (const i in codes) {
			const completion = codes[i];
			codes[i] = this.cleanUpCode(prompt ?? "", completion);
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

	cleanUpCode(prompt: string, completion: string): string {
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
}

export class LeapConfig {
	/**
	 * Config constructor.
	 * @param id ID for the config, used in logging.
	 * @param projectionBoxes Whether Projection Boxes should be enabled.
	 * @param cursor Optional. Will set the main cursor position to this if available.
	 * @param completions Optional hardcoded completions. If this not `undefined`, only this will be displayed.
	 */
	constructor(
		public id: string,
		public group: StudyGroup,
		public cursor?: IPosition,
		public completions?: string[],
	) { }
}

export enum LeapState {
	Off,
	Loading,
	Shown,
}

export class PythonCode {
	constructor(public readonly code: string) { }
}
export class ErrorMessage {
	constructor(public readonly message: string) { }
}
export type Completion = PythonCode | ErrorMessage;

export interface ILeapLogger {
	modelRequest(request: OpenAIRequest): Promise<void>;
	modelResponse(completions: Completion[]): Promise<void>;
	preview(completionId: number, completion: string): Promise<void>;
	panelState(state: LeapState): Promise<void>;
	panelOpen(): Promise<void>;
	panelClose(): Promise<void>;
	panelFocus(): Promise<void>;
	panelUnfocus(): Promise<void>;
}

export abstract class ALeapLogger extends ALogger implements ILeapLogger {
	async modelRequest(request: OpenAIRequest) {
		const id = await this.log('leap.modelRequest');
		await this.write(id, 'request.json', request);
	}

	async modelResponse(completions: Completion[]) {
		const id = await this.log('leap.modelResponse');
		await this.write(id, 'response.json', completions);
	}

	async preview(completionId: number, completion: string) {
		const id = await this.log('leap.preview', `${completionId}`);
		await this.write(id, `preview_${completionId}_content.py`, completion);
	}

	async panelState(state: LeapState) {
		await this.log('leap.panel.state', LeapState[state]);
	}

	async panelOpen() {
		await this.log('leap.panel.open');
	}

	async panelClose() {
		await this.log('leap.panel.close');
	}

	async panelFocus() {
		await this.log('leap.panel.focus');
	}

	async panelUnfocus() {
		await this.log('leap.panel.unfocus');
	}
}
