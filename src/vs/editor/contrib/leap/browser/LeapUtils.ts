import OpenAI from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALeapLogger, ILeapLogger, LeapConfig, ILeapUtils, ALeapUtils, OpenAIMessage, OpenAIRequest } from 'vs/editor/contrib/leap/browser/LeapInterfaces';
import { StudyGroup } from '../../rtv/browser/RTVInterfaces';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';


class LocalUtils extends ALeapUtils {
	public readonly EOL: string = os.EOL;
	private _openAi: OpenAI;
	private _requestTemplate: OpenAIRequest = {
		model: "gpt-4o-mini",
		// model: "gpt-3.5-turbo-instruct",
		// model: "llama3.1:latest",
		temperature: 0.5,
		n: 5,
		max_tokens: 1024,
		stop: [this.EOL + this.EOL],
		stream: true,
		prompt: null,
	};

	constructor() {
		super();

		// Configure OpenAI api
		this._openAi = new OpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			baseURL: process.env.OPENAI_BASE_URL,
			dangerouslyAllowBrowser: true
		});
	}

	async getConfig(): Promise<LeapConfig> {
		return new LeapConfig('local', StudyGroup.Treatment);
	}

	async getCompletions(request: OpenAIRequest, signal: AbortSignal, progressCallback: (e: any) => void): Promise<string[]> {
		console.log("OUR REQUEST LOOKS LIKE:", request);
		// TODO maybe change this to only include comments when user requests them
		const completions = await this._openAi.chat.completions.create({
			model: request.model,
			messages: [
				{
					role: "system",
					content: "You are an expert Python programmer. You complete the user's code as best as possible. Only output the code that would complete this. Do not repeat the prompt in your answer."
				},
				{
					role: "user",
					content: request.prompt ?? ""
				}
			],
			temperature: request.temperature,
			// n: request.n,
			// just ask for one completion for now
			n: 1,
			stop: request.stop,
			max_tokens: request.max_tokens,
			stream: request.stream,
		});


		signal.onabort = ((_) => { completions.controller.abort(); });

		const codes = Array.from({ length: (request.n || 1) }, () => "");
		for await (const part of completions) {
			const i = part.choices[0].index;
			const delta = part.choices[0].delta.content ?? '';
			codes[i] += delta;
			progressCallback(part);
		}

		return this.cleanUpCompletions(request, codes);
	}

	// TODO maybe return tests as string[] instead of one giant string?
	async getTestCasesForCode(code: string, origPrompt: string, signal: AbortSignal, progressCallback: (e: any) => void): Promise<string[]> {
		const completion = await this._openAi.chat.completions.create({
			model: this._requestTemplate.model,
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
			max_tokens: this._requestTemplate.max_tokens,
			stream: true,
		});

		signal.onabort = ((_) => { completion.controller.abort(); });

		let response = "";
		for await (const part of completion) {
			const delta = part.choices[0].delta.content ?? '';
			response += delta;
			progressCallback(part);
		}

		// separate by code blocks (assume ```py and ```)
		const testcases: string[] = [];
		while (response.indexOf("```") !== -1) {
			response = response.substring(response.indexOf("```"));
			response = response.substring(response.indexOf("\n"));
			const testcase = response.substring(0, response.indexOf("```")).trim();
			testcases.push(testcase);
			response = response.substring(response.indexOf("```") + 3);
		}

		return testcases;
	}

	getLogger(editor: ICodeEditor): ILeapLogger {
		return new LeapLogger(editor);
	}

	async buildRequest(prefix: string, suffix: string): Promise<OpenAIRequest> {
		return {
			...this._requestTemplate,
			prompt: prefix,
			suffix: suffix
		};
	}

	parsePromptFile(filename: string, substitutions: { [key: string]: string }): OpenAIMessage[] {
		const filePath = filename;

		if (!fs.existsSync(filePath)) {
			throw new Error(`Could not find prompt file ${filePath}`);
		}

		const text = fs.readFileSync(filePath, 'utf-8');
		return this.createPromptFromTemplate(text, substitutions);
	}
}


export function getUtils(): ILeapUtils {
	return new LocalUtils();
}

export class LeapLogger extends ALeapLogger {
	// States for various things we need to log
	private logDir: string;
	private currentFileName: string = 'unknown';
	private readonly logFile: string;

	constructor(private editor: ICodeEditor) {
		super();

		// Build output dir name
		let dir = process.env['LOG_DIR'];

		if (!dir) {
			dir = os.tmpdir() + path.sep;
		} else {
			if (!dir.endsWith(path.sep)) {
				dir += path.sep;
			}

			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir);
			}
		}

		// Build an fs-safe date/time:
		const now = new Date();
		dir += `snippy_log_${now.getMonth() + 1}-${now.getDate()}_${now.getHours()}-${now.getMinutes()}_${now.getSeconds()}`;

		// Don't overwrite existing logs!
		if (fs.existsSync(dir!!)) {
			console.error('Two log dirs created at the exact same time. This should not happen.');
			let counter = 0;
			dir = dir + '_' + counter;
			while (fs.existsSync(dir)) {
				dir = dir.substring(0, dir.length - 1) + counter++;
			}
		}

		this.logDir = dir! + path.sep;
		fs.mkdirSync(this.logDir);
		this.logFile = 'snippy_plus.log';
	}

	private now(): string {
		return new Date().getTime().toString();
	}

	protected async log(code: string, msg?: string): Promise<string | undefined> {
		let str: string;
		const id = this.now();

		if (msg) {
			msg = msg.replace(/\n/g, '\\n');
			str = `${id},${this.now()},${this.getCurrentFileName()},${code},${msg}`;
		} else {
			str = `${id},${this.now()},${this.getCurrentFileName()},${code}`;
		}

		console.log(str);
		await fs.promises.appendFile(this.logDir + this.logFile, str + '\n');
		return id;
	}

	protected async write(id: string | undefined, file: string, content: string): Promise<void> {
		let done = false;
		let fileName = `${id}_${file}`;
		let counter = 0;

		console.debug(fileName, ':\n', content);

		while (!done) {
			try {
				const fd = await fs.promises.open(fileName, 'wx');
				await fd.writeFile(content);
				done = true;
			} catch (err) {
				if (err.code === 'EEXIST') {
					// The file already exists.
					fileName = `${id}_${counter}_${file}`;
					counter += 1;
				} else {
					console.error('log write() failed:\n', err);
					done = true;
				}
			}
		}
	}

	private getCurrentFileName() {
		const rs = this.editor.getModel()?.uri.toString();

		if (rs) {
			if (!rs.includes(this.currentFileName)) {
				const start = rs.lastIndexOf('/') + 1;
				const end = rs.length - start - 3;
				this.currentFileName = rs.substr(start, end);
			}
		} else {
			this.currentFileName = 'unknown';
		}

		return this.currentFileName;
	}
}
