import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IModelContentChangedEvent } from 'vs/editor/common/textModelEvents';
import { EditorAction, registerEditorAction, registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { ILanguageService } from 'vs/editor/common/languages/language';
import { MarkdownRenderer } from 'vs/editor/contrib/markdownRenderer/browser/markdownRenderer';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { Range } from 'vs/editor/common/core/range';
// import { MarkdownString } from 'vs/base/common/htmlContent';
import { IThemeService } from 'vs/platform/theme/common/themeService';
// import { editorBackground, editorErrorBackground, editorErrorForeground, editorForeground, editorErrorBorder } from 'vs/platform/theme/common/colorRegistry';
// import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { LeapConfig, ILeapUtils, PythonCode, ErrorMessage, Completion, LeapState, ILeapLogger } from 'vs/editor/contrib/leap/browser/LeapInterfaces';
import { getUtils } from 'vs/editor/contrib/leap/browser/LeapUtils';
import { IRTVController, ViewMode } from '../../rtv/browser/RTVInterfaces';
import { RTVController } from '../../rtv/browser/RTVDisplay';
import { ITextModel } from 'vs/editor/common/model';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { editorBackground, editorErrorBackground, editorErrorBorder, editorErrorForeground, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { clipboard } from 'electron';
import { ChatCompletionMessageParam } from 'openai/resources';
import { getCodeCompletions, getConvoResponse, getLineCommentsExplanation, getOverviewExplanation, summarizeConvo } from 'vs/editor/contrib/leap/browser/Chat';

const htmlPolicy = window.trustedTypes?.createPolicy('leap', { createHTML: (value) => value, createScript: (value) => value });

function setInner(elem: HTMLElement, inner: string): void {
	if (htmlPolicy) {
		elem.innerHTML = htmlPolicy.createHTML(inner) as unknown as string;
	} else {
		// @ts-ignore
		elem.innerHTML = inner;
	}
}

/**
 * Helper function for waiting in an async environment.
 */
async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

class Leap implements IEditorContribution {

	// ---------------------------
	// Static fields and functions
	// ---------------------------

	public static ID: string = 'editor.contrib.leap';

	public static readonly completionComment = '## ---';

	public static get(editor: ICodeEditor): Leap {
		const rs = editor.getContribution<Leap>(Leap.ID);
		if (!rs) {
			throw new Error('Leap contribution not found. This should not happen.');
		}
		return rs;
	}

	// -----------------------------------
	// The actual class fields and methods
	// -----------------------------------

	private _editor: ICodeEditor;
	private _themeService: IThemeService;
	private _mdRenderer: MarkdownRenderer;

	private panel: HTMLElement | undefined;
	private codeSection: HTMLElement | undefined;
	private explanationSection: HTMLElement | undefined;
	private testcasesSection: HTMLElement | undefined;
	private convoSection: HTMLElement | undefined;
	private actionBar: HTMLElement | undefined;

	// private _lastCompletions: Completion[] | undefined;
	// private _lastExplanations: Explanation[] | undefined;
	// private _lastTestcases: (string[])[] | undefined;
	// private _lastPrompt: string | undefined;

	// TODO
	private codePrompt: string | undefined;
	private completions: Completion[] | undefined;
	private overviewExplanation: string | undefined;
	private lineComments: string | undefined;
	private testcases: string[] | undefined;
	private convo: ChatCompletionMessageParam[] = [];

	private highlightingCode = false;

	private viewingLineComments = false;
	private copiedLineComments = false;
	private explanationLevelSummary: string | undefined;

	// max verbosity is 5
	private verbosityLevel = 5;
	private convoElements: Record<number, HTMLElement> = {};
	private visibleConvoElements: Record<number, boolean> = {};

	private metrics = {
		numShortened: 0,
		numExpanded: 0,
	};

	// private metrics = {
	// 	totalHighLevelExplanationsAsked: 0,
	// 	totalLineExplanationsAsked: 0,
	// 	totalTestcasesAsked: 0,

	// 	topicsNeedExplain: [] as string[],
	// 	topicsHighLevelExplanationsCount: {} as Record<string, number>,
	// 	topicsLineExplanationsCount: {} as Record<string, number>,
	// 	topicsTestcasesCount: {} as Record<string, number>,
	// };

	private _lastCursorPos: IPosition | undefined;
	private _state: LeapState = LeapState.Off;
	private _utils: ILeapUtils = getUtils();
	private _logger: ILeapLogger;
	private _decorationList: string[] = [];
	private _suggestionDecor: string = 'bgcolor';
	private _config?: LeapConfig = undefined;
	private _projectionBoxes: IRTVController;
	private _abort: AbortController;

	public constructor(
		editor: ICodeEditor,
		@IThemeService themeService: IThemeService,
		@IOpenerService openerService: IOpenerService,
		@ILanguageService langService: ILanguageService) {

		this._abort = new AbortController();
		this._editor = editor;
		this._themeService = themeService;
		this._projectionBoxes = editor.getContribution(RTVController.ID)!;
		this._logger = this._utils.getLogger(editor);

		this._mdRenderer = new MarkdownRenderer(
			{ 'editor': this._editor },
			langService,
			openerService);

		this._utils.getConfig().then(async (config) => {
			this._config = config;

			// Wait for the editor to load
			while (!this._editor.getDomNode()) {
				await sleep(500);
			}

			// Move the cursor if necessary.
			if (this._config.cursor) {
				this._editor.setPosition(this._config.cursor);
			}

			// // Register event handlers.
			// addEventListener('leap', (e: any) => {
			// 	const completionId = e.detail;
			// 	if (completionId === undefined) {
			// 		console.error('Completion ID was undefined:', completionId);
			// 		return;
			// 	}
			// 	this.previewCompletion(completionId);
			// });

			this._editor.onDidChangeModelContent((e) => { this.onDidChangeModelContent(e); });
			this._editor.onDidChangeCursorSelection((e) => {
				if (!e.selection.isEmpty() && this.getHighlightedTextFromEditor()) {
					this.highlightingCode = true;
				} else {
					this.highlightingCode = false;
				}
			});

			// Disable projection boxes if necessary.
			// this._projectionBoxes.studyGroup = this._config.group;
			// NOTE disabling projection boxes for now
			// if (this._config.group === StudyGroup.Control) {
			// 	this._projectionBoxes.changeViewMode(ViewMode.Stealth);
			// }
			this._projectionBoxes.changeViewMode(ViewMode.Full);

			// [lisa] Bad Hack: Disable the KeyDown handler on `Escape` in Projection Boxes
			// For preventing the Projection Boxes to show Full View when the user presses `Escape`
			// which is needed for Leap cancellation.
			this._projectionBoxes.toggleLeapOn();

			// Finally, toggle if this is in hardcoded mode
			if (this._config?.completions) {
				await this._projectionBoxes.runProgram();
				await this.toggle();
			}
		});
	}

	public set state(state: LeapState) {
		console.debug(`State <- ${LeapState[state]}`);
		this._logger.panelState(state);
		this._state = state;
	}

	public get state(): LeapState {
		return this._state;
	}

	public async dispose() {
		this._logger.panelClose();
		this.panel?.remove();
		this.panel = undefined;

		// don't include curr explanation prefs in system
		// analyze the current convo without it
		this.convo[0].content = "You are an expert programmer. You assist the user by completing code and explaining it when necessary.";
		const summary = await summarizeConvo(this.convo, this._abort.signal);
		console.log("Summary:", summary);
		this.explanationLevelSummary = summary;
		this.lineComments = undefined;
		this.codePrompt = undefined;
		this.completions = undefined;
		this.overviewExplanation = undefined;
		this.lineComments = undefined;
		this.convo = [];

	}

	public async toggle(): Promise<void> {
		this._abort.abort();
		const abort = new AbortController();
		this._abort = abort;

		switch (this.state) {
			case LeapState.Off:
			case LeapState.Loading:
				// Just start!
				this.state = LeapState.Loading;
				await this.startCompletion();
				break;
			case LeapState.Shown:
				this.hideCompletions();
				this.state = LeapState.Off;
				break;
			default:
				console.error('Leap State not recognized: ', this.state);
		}
	}

	// clears out the code completion indicated by the completion comments, if any
	public async escape(): Promise<void> {
		this._abort.abort();

		if (this.state !== LeapState.Off) {
			// set commentOnly to false so that we remove the text as well
			this.hideCompletions(false);
			this.state = LeapState.Off;
		}
	}

	/**
	 * Creates the panel if it doesn't already exist.
	 * Clears the content if it does.
	 */
	public createPanel(): HTMLElement {
		if (!this.panel) {
			const editor_div = this._editor.getDomNode();
			if (!editor_div) {
				throw new Error('Editor Div does not exist. This should not happen.');
			}

			this.panel = document.createElement('div');

			// Set the panel style
			this.panel.className = 'monaco-hover';
			this.panel.style.position = 'absolute';
			this.panel.style.top = '30px';
			this.panel.style.bottom = '14px';
			this.panel.style.right = '14px';
			this.panel.style.width = '700px';
			this.panel.style.padding = '10px';
			this.panel.style.transitionProperty = 'all';
			this.panel.style.transitionDuration = '0.2s';
			this.panel.style.transitionDelay = '0s';
			this.panel.style.transitionTimingFunction = 'ease';
			this.panel.style.overflowX = 'visible';
			// this._panel.style.overflowY = 'clip';
			this.panel.style.overflowY = 'auto';
			// this._panel.style.userSelect = "text";
			this.panel.onwheel = (e) => {
				e.stopImmediatePropagation();
			};
			this.panel.onmouseenter = (e) => {
				this.expandPanel();
			};
			this.panel.onmouseleave = (e) => {
				if (e.offsetY < 0 || e.offsetX < 0) {
					this.compressPanel();
				}
			};

			// const compressButton = document.createElement("button");
			// compressButton.className = 'monaco-button';
			// compressButton.id = "compress-button";
			// compressButton.style.position = "absolute";
			// compressButton.style.top = "50%";
			// compressButton.style.left = "0%";
			// compressButton.style.transform = "translate(-100%, -50%)";
			// // compressButton.style.width = "20px";
			// compressButton.style.height = "50px";
			// compressButton.style.border = "none";
			// compressButton.style.borderTopLeftRadius = "10px";
			// compressButton.style.borderBottomLeftRadius = "10px";
			// compressButton.style.cursor = "pointer";
			// compressButton.style.fontWeight = "bold";
			// compressButton.textContent = ">";
			// compressButton.onclick = (e) => {
			// 	if (compressButton.textContent === ">") {
			// 		this.compressPanel();
			// 		compressButton.textContent = "<";
			// 	} else {
			// 		this.expandPanel();
			// 		compressButton.textContent = ">";
			// 	}
			// };
			// this._panel.appendChild(compressButton);

			editor_div.appendChild(this.panel);
		}

		// NOTE: Technically this is never needed since we create panel only when toggling
		// when we toggle off, interestingly we delete the panel
		// Clear the panel content
		this.clearElement(this.panel);

		this._logger.panelOpen();

		return this.panel;
	}

	public compressPanel(): void {
		this._logger.panelUnfocus();

		if (this.panel) {
			this.panel.style.right = '-500px';
			this.panel!.style.zIndex = '0';
			this.panel.style.opacity = '0.3';
		}
	}

	public expandPanel(): void {
		this._logger.panelFocus();

		if (this.panel) {
			this.panel.style.right = '14px';
			this.panel!.style.zIndex = '1000';
			this.panel.style.opacity = '1';
		}
	}

	public async startCompletion(): Promise<void> {
		// first, create and clear the panel
		this.createPanel();

		// get text of editor to work with for ai stuff and create prompt
		const editorText = this.getTextFromEditor();
		if (!editorText) {
			// show nothing
			return;
		}
		const { prefix, suffix } = editorText;

		// panel is clean
		// fetch the completions
		this.completions = await this.getCompletions(prefix, suffix);
		this.convo.push(
			{
				role: 'system',
				content: "You are an expert programmer. You assist the user by completing code and explaining it when necessary." + (this.explanationLevelSummary ? ` You are also aware that the user prefers the following type of explanations: ${this.explanationLevelSummary}. When explaining, provide the level of detail according to these preferences.` : " When explaining, provide the level of detail that the user requests for.") + " Do not include the user's prompt, and do not say anything unnecessary."
			},
			{
				role: 'user',
				content: prefix,
			},
			{
				role: "assistant",
				content: this.completions && this.completions.length > 0 && this.completions[0] instanceof PythonCode ? this.completions[0].code : "",
			}
		);
		// this._lastCompletions = await this.getCompletions(prefix, suffix);
		this.overviewExplanation = undefined;

		// display completions
		// show the first page of the completions
		this.renderCompletionPage();

		// Finally, update the state.
		this.state = LeapState.Shown;
		this.previewCompletion();
	}


	public getTextFromEditor(): { prefix: string; suffix: string } | void {
		// this._lastCompletions = this._config?.completions?.map(code => new PythonCode(code));
		// First, create the prompt

		// First, get the text from the editor
		const model = this._editor.getModel();
		if (!model) {
			console.error(`Can't toggle Leap: model is ${model}`);
			return;
		}

		// Get the cursor position
		const pos = this._editor.getPosition();
		if (pos === null) {
			console.error(`Can't toggle Leap: cursor position is ${pos}`);
			return;
		}

		// Get text before and after the cursor
		// This will be our prompt
		this._lastCursorPos = pos;
		const lastLineIdx = model.getLineCount() - 1;
		const lastLineWidth = model.getLineMaxColumn(lastLineIdx);
		const prefix: string = model.getValueInRange(new Range(0, 0, pos.lineNumber, pos.column));
		const suffix: string = model.getValueInRange(new Range(pos.lineNumber, pos.column, lastLineIdx, lastLineWidth));

		return { prefix, suffix };
	}

	public getHighlightedTextFromEditor(): string | void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const selection = this._editor.getSelection();
		if (selection === null) {
			return;
		}

		return model.getValueInRange(selection);
	}

	/**
	 * Gets code completions. Also displays a loading page too. Returns the Completions.
	 * Not quite a pure function as named, since it clears panel and adds loading UI elements.
	 * It is guaranteed there will be at least one elem in returned list (either error or completion)
	 *
	 * @param prefix All text in editor before cursor (used in completion prompt)
	 * @param suffix All text in editor after cursor ()
	 * @returns List of PythonCode snippets or Errors (that can be displayed)
	 */
	public async getCompletions(prefix: string, suffix: string): Promise<Completion[]> {
		const results: Completion[] = [];

		if (!this.panel) {
			console.error("no panel created");
			return results;
		}

		try {
			// Start by putting a progress bar in the panel
			const container = document.createElement('div');
			const title = document.createElement('h2');
			title.innerText = 'Getting suggestion. Please wait...';
			const barContainer = document.createElement('div');
			const progressBar = new ProgressBar(barContainer).total(10);
			const barElement = progressBar.getContainer();
			barElement.style.position = 'inherit';
			(barElement.firstElementChild! as HTMLElement).style.position = 'inherit';
			container.appendChild(title);
			container.appendChild(barContainer);
			this.panel.appendChild(container);

			// request the completions
			this.codePrompt = prefix;
			const codes = await getCodeCompletions(
				this.codePrompt,
				this._abort.signal,
				(_e) => progressBar.worked(1)
			);

			results.push(...codes.map((c) => new PythonCode(c)));

			console.debug('Got the following completions from the server:\n', codes);

			// if no codes found, simply just have error message
			if (codes.length === 0) {
				results.push(new ErrorMessage('All suggestions were empty. Please try again.'));
			}

			// clean up UI elements no longer needed for loading suggestions
			progressBar.dispose();
			container.remove();
		} catch (error: any) {
			if (error.message === 'canceled' || error instanceof DOMException && error.message.includes('The operation was aborted')) {
				// This error was cancelled.
				console.debug('Request cancelled:\n', error);
				results.push(new ErrorMessage("Request cancelled by the user."));
				return results;
			}

			if (error.response) {
				console.error(error.response.status, error.response.data);
				console.error(error);

				let code: string = String(error.response.status);
				if ('error' in error.response.data && 'code' in error.response.data.error) {
					code += `: ${error.response.data.error.code}`;
				}

				let message;
				if ('error' in error.response.data && 'message' in error.response.data.error) {
					message = error.response.data.error.message;
				} else {
					message = error.response.data;
				}

				results.push(new ErrorMessage(`[${code}]\n${message}`));
			} else {
				console.error('Error with OpenAI API request:');
				console.error(error);
				results.push(new ErrorMessage(error.message));
			}
		}

		this._logger.modelResponse(results);
		return results;
	}

	/**
	 * Clears the elem of every single child node
	 * @returns
	 */
	private clearElement(elem: HTMLElement) {
		// had issues with using foreach, led to some stuff being done async?
		// instead, gonna use a loop like this, more deterministic
		let child = elem.firstElementChild;
		while (child) {
			const nextChild = child.nextElementSibling;
			elem.removeChild(child);
			child = nextChild;
		}
	}

	/**
	 * Displays a suggestion page, which the full code completion and other actions for this particular completion
	 *
	 * @param index The index of the completions array to display this suggestion for
	 * @returns
	 */
	private async renderCompletionPage() {
		if (!this.panel) {
			console.error('displaySuggestion called with no panel!');
			return;
		}

		if (!this.completions || this.completions.length <= 0) {
			console.error('displaySuggestion called with nothing');
			return;
		}

		this.clearElement(this.panel);

		// show code completion
		this.codeSection = document.createElement("div");
		this.codeSection.style.marginBottom = "10px";
		this.panel.appendChild(this.codeSection);
		const completion = this.completions[0];
		if (completion instanceof ErrorMessage) {
			this.renderError();
			return;
		} else if (completion instanceof PythonCode) {
			this.renderPython();
		}

		// show explanation
		this.explanationSection = document.createElement("div");
		this.explanationSection.style.marginBottom = "10px";
		this.panel.appendChild(this.explanationSection);
		// this.showExplanation();

		// show convo
		this.convoSection = document.createElement("div");
		this.convoSection.style.borderTop = "2px solid gray";
		this.convoSection.style.paddingTop = "20px";
		this.convoSection.style.marginBottom = "10px";
		this.panel.appendChild(this.convoSection);

		// show actions at bottom of panel
		this.renderActionBar();
	}

	/**
	 * Renders an error message page
	 *
	 * @param index
	 * @param error
	 * @returns
	 */
	private renderError() {
		if (!this.codeSection) {
			console.error('renderError called with no panel or section!');
			return;
		}
		if (!this.completions || this.completions.length <= 0 || !(this.completions[0] instanceof ErrorMessage)) {
			console.error('renderError called with no completion errors!');
			return;
		}

		this.clearElement(this.codeSection);

		const error = this.completions[0] as ErrorMessage;

		const block = document.createElement('div');
		const md = new MarkdownString();
		md.appendMarkdown('> **ERROR!**\n>\n');
		for (const line of error.message.split('\n')) {
			md.appendMarkdown(`> ${line}\n>\n`);
		}

		// Style it!
		const theme = this._themeService.getColorTheme();
		const codeWrapper = document.createElement('div');
		codeWrapper.style.padding = '10px';
		codeWrapper.style.borderRadius = '3px';
		codeWrapper.style.borderWidth = '1px';
		codeWrapper.style.borderColor = theme.getColor(editorErrorBorder)?.toString() ?? '';
		codeWrapper.style.backgroundColor = theme.getColor(editorErrorBackground)?.toString() ?? '';
		codeWrapper.style.color = theme.getColor(editorErrorForeground)?.toString() ?? '';
		codeWrapper.appendChild(this._mdRenderer.render(md).element);

		block.appendChild(codeWrapper);

		this.codeSection.appendChild(block);
	}

	/**
	 * Renders a code completion page, with available actions for this particular completion
	 *
	 * @param index
	 * @param code
	 * @returns
	 */
	private renderPython() {
		if (!this.codeSection) {
			console.error('renderPython called with no panel! ');
			return;
		}

		if (!this.completions || this.completions.length <= 0) {
			console.error('renderPython called with no completions');
			return;
		}

		const completion = this.completions[0];
		if (!(completion instanceof PythonCode)) {
			console.error('renderPython not called with pythoncode');
			return;
		}

		this.clearElement(this.codeSection);

		const block = document.createElement('div');
		block.style.marginBottom = '20px';

		// First, append the title
		const title = document.createElement('h2');
		setInner(title, `Suggested code`);
		block.appendChild(title);

		// Render the code suggestion
		// if we have line comments, display that instead
		let completionCode = this.lineComments && this.viewingLineComments ? this.lineComments : completion.code;
		// Prepend whitespace if necessary
		if (this._lastCursorPos?.column) {
			completionCode = ' '.repeat(this._lastCursorPos.column - 1) + completionCode;
		}
		// Add the code block itself
		const md = new MarkdownString();
		md.appendCodeblock(this.getCurrentLanguage() ?? "", completionCode);
		// Style it!
		const theme = this._themeService.getColorTheme();
		const codeWrapper = document.createElement('div');
		codeWrapper.style.padding = '10px';
		codeWrapper.style.borderRadius = '3px';
		codeWrapper.style.borderWidth = '1px';
		codeWrapper.style.borderColor = theme.getColor(editorForeground)?.toString() ?? '';
		codeWrapper.style.backgroundColor = theme.getColor(editorBackground)?.toString() ?? '';
		codeWrapper.style.marginTop = "5px";
		codeWrapper.style.marginBottom = "10px";
		codeWrapper.appendChild(this._mdRenderer.render(md).element);
		block.appendChild(codeWrapper);

		const actionButtonsDiv = document.createElement('div');
		actionButtonsDiv.style.display = 'flex';
		actionButtonsDiv.style.flexDirection = 'row';
		actionButtonsDiv.style.justifyContent = 'flex-start';
		actionButtonsDiv.style.marginTop = '10px';
		actionButtonsDiv.style.marginBottom = '10px';
		actionButtonsDiv.style.gap = '12px';
		block.appendChild(actionButtonsDiv);

		const previewLink = document.createElement('a');
		previewLink.textContent = "Copy to Editor";
		previewLink.style.display = "block";
		previewLink.style.color = "white";
		previewLink.style.padding = "4px 10px";
		previewLink.style.backgroundColor = "rgb(14, 99, 156)";
		previewLink.onclick = (_) => {
			this.previewCompletion();
			this.compressPanel();
		};
		actionButtonsDiv.appendChild(previewLink);

		const revertLink = document.createElement('a');
		revertLink.textContent = "Revert";
		revertLink.style.display = "block";
		revertLink.style.padding = "4px 10px";
		revertLink.onclick = (_) => {
			this.removeCompletion(false);
		};
		actionButtonsDiv.appendChild(revertLink);

		if (!this.lineComments) {
			// allow user to create them
			const explainLineLink = document.createElement('a');
			explainLineLink.textContent = "Add Line-by-Line Comments";
			explainLineLink.style.display = "block";
			explainLineLink.style.color = "white";
			explainLineLink.style.marginLeft = "auto";
			explainLineLink.style.padding = "4px 10px";
			explainLineLink.style.backgroundColor = "rgb(14, 99, 156)";
			explainLineLink.onclick = (_) => {
				this.viewingLineComments = true;
				this.showLineComments();
			};
			actionButtonsDiv.appendChild(explainLineLink);
		} else {
			// allow toggling between the two
			const toggleLineCommentsLink = document.createElement('a');
			toggleLineCommentsLink.textContent = this.viewingLineComments ? "Hide Comments" : "Show Comments";
			toggleLineCommentsLink.style.display = "block";
			toggleLineCommentsLink.style.color = "white";
			toggleLineCommentsLink.style.marginLeft = "auto";
			toggleLineCommentsLink.style.padding = "4px 10px";
			toggleLineCommentsLink.style.backgroundColor = "rgb(14, 99, 156)";
			toggleLineCommentsLink.onclick = (_) => {
				this.viewingLineComments = !this.viewingLineComments;
				this.renderPython();
			};
			actionButtonsDiv.appendChild(toggleLineCommentsLink);
		}

		this.codeSection.appendChild(block);
	}

	private renderActionBar() {
		if (!this.panel) {
			console.error('renderActionBar called with no panel!');
			return;
		}
		this.actionBar = document.createElement("div");
		this.actionBar.style.marginTop = "40px";
		this.actionBar.style.marginBottom = "10px";

		const quickStuff = document.createElement("div");
		quickStuff.style.display = "flex";
		quickStuff.style.flexDirection = "row";
		quickStuff.style.justifyContent = "flex-start";
		quickStuff.style.gap = "12px";
		this.actionBar.appendChild(quickStuff);

		const explainOverviewLink = document.createElement('a');
		explainOverviewLink.textContent = this.highlightingCode ? "Explain Overview" : "Explain Overview";
		explainOverviewLink.style.color = "white";
		explainOverviewLink.style.display = "block";
		explainOverviewLink.style.padding = "4px 10px";
		explainOverviewLink.style.backgroundColor = "rgb(14, 99, 156)";
		explainOverviewLink.onclick = (_) => {
			this.showExplanation();
		};
		quickStuff.appendChild(explainOverviewLink);

		const exampleTestsLink = document.createElement('a');
		exampleTestsLink.textContent = this.highlightingCode ? "Example Tests" : "Example Tests";
		exampleTestsLink.style.color = "white";
		exampleTestsLink.style.display = "block";
		exampleTestsLink.style.padding = "4px 10px";
		exampleTestsLink.style.backgroundColor = "rgb(14, 99, 156)";
		exampleTestsLink.onclick = (_) => {
			this.showTestcases();
		};
		quickStuff.appendChild(exampleTestsLink);


		const explainMoreLink = document.createElement('a');
		explainMoreLink.textContent = "Expand Prev Response";
		explainMoreLink.style.color = "white";
		explainMoreLink.style.display = "block";
		explainMoreLink.style.padding = "4px 10px";
		explainMoreLink.style.backgroundColor = "rgb(14, 99, 156)";
		explainMoreLink.onclick = (_) => {
			this.hideConvoResponse(this.convo.length - 1);
			this.addToConvo("Please provide more details in your previous response.", undefined, undefined, true);
		};
		quickStuff.appendChild(explainMoreLink);

		const shortenLink = document.createElement('a');
		shortenLink.textContent = "Shorten Prev Response";
		shortenLink.style.color = "white";
		shortenLink.style.display = "block";
		shortenLink.style.padding = "4px 10px";
		shortenLink.style.backgroundColor = "rgb(14, 99, 156)";
		shortenLink.onclick = (_) => {
			this.hideConvoResponse(this.convo.length - 1);
			this.addToConvo("Please shorten your previous response.", undefined, undefined, true);
		};
		quickStuff.appendChild(shortenLink);

		const selectedTextMsg = document.createElement("p");
		selectedTextMsg.textContent = "(Text Selected in Editor will be used)";
		selectedTextMsg.style.color = "white";
		selectedTextMsg.style.fontStyle = "italic";
		selectedTextMsg.style.display = "none";
		this.actionBar.appendChild(selectedTextMsg);


		this._editor.onDidChangeCursorSelection((e) => {
			if (!e.selection.isEmpty() && this.getHighlightedTextFromEditor()) {
				this.highlightingCode = true;
			} else {
				this.highlightingCode = false;
			}
			// explainOverviewLink.textContent = this.highlightingCode ? "Give Overview for Selected" : "Give Overview";
			// exampleTestsLink.textContent = this.highlightingCode ? "Example Tests for Selected" : "Example Tests";
			selectedTextMsg.style.display = this.highlightingCode ? "block" : "none";
		});

		const messagesDiv = document.createElement("div");
		messagesDiv.style.marginTop = "10px";
		this.actionBar.appendChild(messagesDiv);

		const messageInput = document.createElement("textarea");
		messageInput.placeholder = "Ask for more details...";
		messageInput.style.height = "50px";
		messageInput.style.padding = "5px";
		messageInput.style.fontFamily = "inherit";
		messageInput.style.color = "white";
		messageInput.style.borderRadius = "4px";
		messageInput.style.width = "90%";
		messageInput.style.backgroundColor = "rgb(60, 60, 60)";
		messagesDiv.appendChild(messageInput);

		const sendMessageButton = document.createElement("a");
		sendMessageButton.textContent = "Send";
		sendMessageButton.style.display = "block";
		sendMessageButton.style.width = "fit-content";
		sendMessageButton.style.padding = "4px 10px";
		sendMessageButton.style.backgroundColor = "rgb(14, 99, 156)";
		sendMessageButton.style.color = "white";
		sendMessageButton.onclick = async (_) => {
			if (!messageInput.value.trim()) {
				return;
			}

			const selectedText = this.getHighlightedTextFromEditor();
			if (selectedText && selectedText.trim() !== "") {
				await this.addToConvo(messageInput.value.trim(), selectedText);
			} else {
				await this.addToConvo(messageInput.value.trim());
			}

			messageInput.value = "";
		};
		messagesDiv.appendChild(sendMessageButton);

		this.panel.appendChild(this.actionBar);
	}


	private async showExplanation() {
		const selectedText = this.getHighlightedTextFromEditor();
		if (selectedText && selectedText.trim() !== "") {
			await this.addToConvo("Provide an explanation of this portion of the code.", selectedText);
		} else {
			await this.addToConvo("Provide an explanation of the code.");
		}
	}

	private async showLineComments() {
		if (!this.codeSection) {
			console.error('showLineComments called with no section');
			return;
		}

		if (!this.completions || this.completions.length <= 0) {
			console.error('showLineComments called with nothing');
			return;
		}

		const completion = this.completions[0];
		if (!(completion instanceof PythonCode)) {
			console.error(`showLineComments called with entry is an error:\n${completion.message}`);
			return;
		}

		if (this.lineComments) {
			console.error('showLineComments called with line comments already existing');
			return;
		}

		// create loading ui stuff
		const container = document.createElement('div');
		const loadingTitle = document.createElement('h3');
		loadingTitle.innerText = 'Getting explanations. Please wait...';
		const barContainer = document.createElement('div');
		const progressBar = new ProgressBar(barContainer).total(10);
		const barElement = progressBar.getContainer();
		barElement.style.position = 'inherit';
		(barElement.firstElementChild! as HTMLElement).style.position = 'inherit';
		container.appendChild(loadingTitle);
		container.appendChild(barContainer);
		this.codeSection.appendChild(container);

		this.lineComments = await getLineCommentsExplanation(
			completion.code,
			this.codePrompt ?? "",
			this._abort.signal,
			(_e) => progressBar.worked(1)
		);

		// done loading, clear loading ui
		progressBar.dispose();
		container.remove();
		this.renderPython();
	}

	private async showTestcases() {
		// TODO
		const selectedText = this.getHighlightedTextFromEditor();
		if (selectedText && selectedText.trim() !== "") {
			await this.addToConvo("Provide example test cases that showcase the selected code's functionality.", selectedText, true);
		} else {
			await this.addToConvo("Provide example test cases that showcase the code's functionality.", undefined, true);
		}
	}

	private async addToConvo(message: string, codeSnippet?: string, reqTestcases?: boolean, modifyExplainPrefs?: boolean) {
		if (!this.convo) {
			this.convo = [];
		}
		if (!this.convoSection) {
			console.error('addToConvo called with no section');
			return;
		}

		// first, render user message
		const userMessageDiv = document.createElement('div');
		userMessageDiv.style.backgroundColor = "#3a3a3a";
		userMessageDiv.style.padding = "4px 10px";
		userMessageDiv.style.maxWidth = "80%";
		userMessageDiv.style.width = "fit-content";
		userMessageDiv.style.borderRadius = "4px";
		userMessageDiv.style.marginLeft = "auto";
		userMessageDiv.style.marginBottom = '10px';
		this.convoSection.appendChild(userMessageDiv);

		if (codeSnippet) {
			const theme = this._themeService.getColorTheme();
			const codeWrapper = document.createElement('div');
			codeWrapper.style.padding = '10px';
			codeWrapper.style.borderRadius = '3px';
			codeWrapper.style.borderWidth = '1px';
			codeWrapper.style.borderColor = theme.getColor(editorForeground)?.toString() ?? '';
			codeWrapper.style.backgroundColor = theme.getColor(editorBackground)?.toString() ?? '';
			const md = new MarkdownString();
			md.appendCodeblock(this.getCurrentLanguage(), codeSnippet);
			codeWrapper.appendChild(this._mdRenderer.render(md).element);
			userMessageDiv.appendChild(codeWrapper);
		}

		const userMessage = document.createElement('p');
		userMessage.textContent = message;
		userMessage.style.color = 'white';
		userMessageDiv.appendChild(userMessage);

		// create loading ui
		const container = document.createElement('div');
		const loadingTitle = document.createElement('h3');
		loadingTitle.innerText = 'Loading response...';
		const barContainer = document.createElement('div');
		const progressBar = new ProgressBar(barContainer).total(10);
		const barElement = progressBar.getContainer();
		barElement.style.position = 'inherit';
		(barElement.firstElementChild! as HTMLElement).style.position = 'inherit';
		container.appendChild(loadingTitle);
		container.appendChild(barContainer);
		this.convoSection.appendChild(container);

		// make openai call
		let fullMsg = (codeSnippet ? codeSnippet + "\n\n" : "") + message;
		if (reqTestcases) {
			fullMsg += "\n\nProvide the test cases as `assert` statements in separate code blocks.";
		}
		if (this.explanationLevelSummary && !modifyExplainPrefs) {
			fullMsg += `\n\nThe user prefers the following type of responses: ${this.explanationLevelSummary}. When responding, provide the level of detail according to these preferences. Do not say anything unnecessary.`;
		}
		const response = await getConvoResponse(
			fullMsg,
			this.convo,
			this._abort.signal,
			(_e) => progressBar.worked(1)
		);

		// done loading, clear loading ui
		progressBar.dispose();
		container.remove();

		// render the response
		const responseDiv = document.createElement('div');
		responseDiv.style.maxWidth = "80%";
		responseDiv.style.width = "fit-content";
		responseDiv.style.borderRadius = "4px";
		responseDiv.style.marginBottom = '10px';

		const hiddenMsg = document.createElement("p");
		hiddenMsg.style.backgroundColor = "rgb(58 58 58)";
		hiddenMsg.textContent = "Response hidden.";
		hiddenMsg.style.fontStyle = "italic";
		hiddenMsg.style.padding = "4px 10px";
		hiddenMsg.style.display = "none";
		responseDiv.appendChild(hiddenMsg);

		const responseContentDiv = document.createElement("div");
		responseContentDiv.style.padding = "4px 10px";
		responseContentDiv.style.backgroundColor = "rgb(58 58 58)";
		responseDiv.appendChild(responseContentDiv);

		if (!response) {
			const md = new MarkdownString();
			md.appendMarkdown('> **ERROR!**\n>\n');
			md.appendMarkdown(`Error getting response, check console for more details.\n>\n`);

			const codeWrapper = document.createElement('div');
			codeWrapper.appendChild(this._mdRenderer.render(md).element);
			responseContentDiv.appendChild(codeWrapper);
		} else {
			// use markdown to render response
			const md = new MarkdownString();
			md.appendMarkdown(response);
			responseContentDiv.appendChild(this._mdRenderer.render(md).element);
		}

		this.convoSection.appendChild(responseDiv);


		this.convo.push({
			role: 'user',
			content: message
		});
		this.convo.push({
			role: 'assistant',
			content: response ?? ""
		});


		const responseElemId = this.convo.length - 1;
		this.convoElements[responseElemId] = responseDiv;
		this.visibleConvoElements[responseElemId] = true;

		const quickStuff = document.createElement("div");
		quickStuff.style.display = "flex";
		quickStuff.style.flexDirection = "row";
		quickStuff.style.justifyContent = "flex-start";
		quickStuff.style.gap = "5px";
		responseDiv.appendChild(quickStuff);

		const hideLink = document.createElement('a');
		hideLink.textContent = "Hide";
		hideLink.style.display = "block";
		hideLink.onclick = (_) => {
			this.hideConvoResponse(responseElemId);
		};
		quickStuff.appendChild(hideLink);
	}

	private hideConvoResponse(idx: number) {
		if (this.convoElements[idx]) {
			this.visibleConvoElements[idx] = !this.visibleConvoElements[idx];
			// get first child of the element and hide it
			const hideMsg = this.convoElements[idx].firstElementChild;
			if (hideMsg) {
				(hideMsg as HTMLElement).style.display = this.visibleConvoElements[idx] ? "none" : "block";
			}
			// get second child of element and show it
			const content = this.convoElements[idx].children[1];
			if (content) {
				(content as HTMLElement).style.display = this.visibleConvoElements[idx] ? "block" : "none";
			}
			const quickStuff = this.convoElements[idx].children[2];
			if (quickStuff) {
				const hideLink = quickStuff.firstElementChild;
				if (hideLink) {
					hideLink.textContent = this.visibleConvoElements[idx] ? "Hide" : "Show";
				}
			}
		}
	}


	private getCurrentLanguage(): string {
		if (!this._editor) {
			console.error("getCurrentLanguage called with no editor");
			return "";
		}
		const model = this._editor.getModel();
		if (!model) {
			console.error("getCurrentLanguage called with no model");
			return "";
		}
		const languageId = model.getLanguageId();
		return languageId;
	}

	private previewCompletion() {
		if (!this.completions || !this.completions[0]) {
			console.error('previewCompletion called with no completion');
			return;
		}

		const completion = this.completions[0];
		if (!(completion instanceof PythonCode)) {
			console.error(`previewCompletion entry is an error:\n${completion.message}`);
			return;
		}

		// this._logger.preview(index, completion.code);

		// TODO (kas) for now, we're assuming that we are indenting with spaces.
		const codeToUse = this.viewingLineComments && this.lineComments ? this.lineComments : completion.code;
		const code =
			Leap.completionComment + '\n' +
			' '.repeat(this._lastCursorPos!.column - 1) + codeToUse + '\n' +
			' '.repeat(this._lastCursorPos!.column - 1) + Leap.completionComment;

		// Get the model for the buffer content
		const model = this._editor.getModel();
		const text = model?.getValue();
		if (!model || !text) {
			return;
		}

		// Get the start and end range to replace
		let start: IPosition;
		let end: IPosition;

		// See if we need to replace an existing completion
		const startIdx = text.indexOf(Leap.completionComment);
		const endIdx = text.lastIndexOf(Leap.completionComment);


		if (startIdx >= 0 && startIdx !== endIdx) {
			// We have a previous completion to replace!
			start = model.getPositionAt(startIdx);
			end = model.getPositionAt(endIdx + Leap.completionComment.length);
		} else if (this._lastCursorPos) {
			// No previous completion to replace. Just insert it.
			start = this._lastCursorPos;
			end = this._lastCursorPos; // TODO (kas) Do we need to set it to the precise position based on the completion?
		} else {
			// Show an error in vscode
			throw new Error('Could not insert suggestion. No previous suggestion to replace and no cursor position to insert at.');
		}

		// Now put the completion in the buffer!
		const range = new Range(start.lineNumber, start.column, end.lineNumber, end.column);

		// Replate that range!
		this._editor.pushUndoStop();
		this._editor.executeEdits(
			Leap.ID,
			[{ range: range, text: code }]);
		this._editor.focus();
		this._editor.setPosition(new Position(start.lineNumber + 1, start.column));
		this.decorateSuggestion();
	}


	private removeCompletion(commentOnly: boolean = true): void {
		// TODO (lisa) error handling.
		if (!this.completions) {
			return;
		}

		// First, get the start and end range to perform the edits.
		// - Get the model for the buffer content
		const model = this._editor.getModel();
		const text = model?.getValue();
		if (!model || !text) {
			return;
		}

		// - See if there are completion comments to remove
		const startIdx = text.indexOf(Leap.completionComment);
		const endIdx = text.lastIndexOf(Leap.completionComment);

		// -- if there are no completion comments, then no edit is necessary
		if (startIdx < 0) {
			// then endIdx must be less than 0 as well
			console.log(`No completion comment removal is necessary`);
			return;
		} else {
			const model = this._editor.getModel()!;
			// -- else, we do the edits

			const start = model.getPositionAt(startIdx);
			const end = model.getPositionAt(endIdx + Leap.completionComment.length);

			let textEndLine: number;
			let textEndCol: number;
			let editEndLine: number;
			let editEndCol: number;

			let singleCompletionComment: boolean = false;

			if (startIdx === endIdx) {
				// there is only one completion comment for whatever weird reason...
				// user accidentally removed the last completion comment? maybe
				// simply removing that line would be enough.

				singleCompletionComment = true;

				// get the end point of the last character in the file
				const numLines = model.getLineCount();
				textEndLine = numLines;
				textEndCol = model.getLineLength(numLines) + 1;

				// record the ending point of the edit range, which would be the end of the entire file
				editEndLine = textEndLine;
				editEndCol = textEndCol;

			} else {
				// there are more than one completion comments.
				// remove the one at the beginning and the one at the end

				// get the end point of the text in between the comments
				const endHead = model.getPositionAt(endIdx);
				const lastLine = model.getLineContent(end.lineNumber - 1);
				textEndLine = end.lineNumber - 1;
				textEndCol = endHead.column + lastLine.length;

				// record the ending point of the edit range
				editEndLine = end.lineNumber;
				editEndCol = end.column;

			}

			// get the existing content within the range
			// suggestion code should be kept only when commentOnly is true or only one completion comment is present
			const textRange = new Range(start.lineNumber + 1, start.column, textEndLine, textEndCol);
			const text = (commentOnly || singleCompletionComment) ? model.getValueInRange(textRange) : '';

			// Finally, keep only the innerText within the edit range
			const editRange = new Range(start.lineNumber, start.column, editEndLine, editEndCol);
			this._editor.pushUndoStop();
			this._editor.executeEdits(
				Leap.ID,
				[{ range: editRange, text: text }]);
		}
	}


	public hideCompletions(commentOnly: boolean = true): void {
		// TODO do we really want to delete everything when we hide completions?
		// first, hide the exploration panel
		this.dispose();

		// second, clean up the comment markups
		// if commentOnly is true, we only remove the comments
		this.removeCompletion(commentOnly);
	}


	public updateSuggestionDecor() {
		switch (this._suggestionDecor) {
			case 'bgcolor':
				this._suggestionDecor = 'opacity';
				break;
			case 'opacity':
				this._suggestionDecor = 'bgcolor';
				break;
			default:
				throw new Error('Invalid suggestion decoration type');
		}

		// if there are already decorated code suggestions, update existing suggestions
		if (this._decorationList.length > 0) {
			this.decorateSuggestion();
		}
	}

	private async onDidChangeModelContent(e: IModelContentChangedEvent) {
		this.decorateSuggestion();
	}

	private async decorateSuggestion() {
		if (this._decorationList.length > 0) {
			this._editor.changeDecorations((c) => {
				this._decorationList.forEach((d) => {
					c.removeDecoration(d);
				});
			});
			this._decorationList = [];
		}

		if (this.state !== LeapState.Shown) {
			return;
		}

		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const maxline = model.getLineCount();
		let start = -1;
		let end = -1;
		for (let k = 1; k <= maxline; k++) {
			if (model.getLineContent(k).indexOf(Leap.completionComment) !== -1) {
				if (start === -1) {
					start = k;
				} else {
					end = k;
					break;
				}
			}
		}
		if (start !== -1 && end !== -1) {
			this.addDecoration(model, start, end, maxline);
		}
	}

	private addDecoration(model: ITextModel, start: number, end: number, maxline: number) {
		switch (this._suggestionDecor) {
			case 'bgcolor':
				this.highlightSuggestionBgColor(model, start, end);
				break;
			case 'opacity':
				this.reduceNonSuggestionOpacity(model, start, end, maxline);
				break;
			default:
				throw new Error('Invalid suggestion decoration type');
		}
	}

	private reduceNonSuggestionOpacity(model: ITextModel, start: number, end: number, maxline: number) {
		// skip the suggestion, including the completion comments
		const range1 = new Range(1, model.getLineMaxColumn(1), start - 1, model.getLineMaxColumn(start - 1));
		let range2: Range | undefined = undefined;
		// reduce opacity of code after the inserted suggestion, if any
		if (end + 1 <= maxline) {
			range2 = new Range(end + 1, model.getLineMaxColumn(end + 1), maxline, model.getLineMaxColumn(maxline));
		}
		const options = { description: 'LEAP Fragment Focus', inlineClassName: 'code-suggestion-opacity', isWholeLine: true };
		this._editor.changeDecorations((c) => {
			// this._decorationList = [c.addDecoration(range, options)];
			this._decorationList = [c.addDecoration(range1, options)];
			if (range2) {
				this._decorationList.push(c.addDecoration(range2, options));
			}
		});
	}

	private highlightSuggestionBgColor(model: ITextModel, start: number, end: number) {
		// skip the completion comments
		const range = new Range(start + 1, model.getLineMaxColumn(start + 1), end - 1, model.getLineMaxColumn(end - 1));
		// [sorin] note: Here are some optios for className that create various versions
		// of background highlighting for LEAP-generated code. For now, we will
		// use 'selectionHighlight' because, of all three options, it is the one
		// that still allows the user to select text and see some contrast between
		// the selected text and the LEAP highlight.
		//   className: 'selectionHighlight'
		//   classname: 'wordHighlight'
		//   className: 'wordHighlightStrong'
		const options = { description: 'LEAP Fragment Focus', className: 'code-suggestion-bgcolor', isWholeLine: true };
		this._editor.changeDecorations((c) => {
			this._decorationList = [c.addDecoration(range, options)];
		});
	}

	public toggleProjectionBoxes() {
		if (this._projectionBoxes.viewMode === ViewMode.Full) {
			this._projectionBoxes.changeViewMode(ViewMode.Stealth);
		} else {
			this._projectionBoxes.changeViewMode(ViewMode.Full);
		}
		console.log("Switching projection boxes view to", this._projectionBoxes.viewMode);
	}
}

class LeapAction extends EditorAction {
	constructor() {
		super({
			id: 'leap.toggle',
			label: 'Toggle Leap',
			alias: 'Toggle Leap',
			precondition: undefined,
			kbOpts: {
				kbExpr: null,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib // TODO (kas) EditorCore?
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): Promise<void> {
		const leap = Leap.get(editor);
		leap.toggle();
	}
}

// write an EditorAction that uses Escape as the primary key
class LeapEscapeAction extends EditorAction {
	constructor() {
		super({
			id: 'leap.escape',
			label: 'Escape Leap',
			alias: 'Escape Leap',
			precondition: undefined,
			kbOpts: {
				kbExpr: null,
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): Promise<void> {
		const leap = Leap.get(editor);
		leap.escape();
	}
}

// write an EditorAction that uses Escape as the primary key
class LeapExplainAction extends EditorAction {
	constructor() {
		super({
			id: 'leap.explain',
			label: 'Escape Leap',
			alias: 'Escape Leap',
			precondition: undefined,
			kbOpts: {
				kbExpr: null,
				primary: KeyMod.Shift | KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyE,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): Promise<void> {
		const leap = Leap.get(editor);
		leap.getHighlightedTextFromEditor();
	}
}


class LeapDecorAction extends EditorAction {
	constructor() {
		super({
			id: 'leap.decor.suggestion',
			label: 'Decorate Leap Suggestion',
			alias: 'Decorate Leap Suggestion',
			precondition: undefined,
			kbOpts: {
				kbExpr: null,
				primary: KeyMod.Shift | KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyD,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): Promise<void> {
		const leap = Leap.get(editor);
		leap.updateSuggestionDecor();
	}
}

class ProjectionBoxesAction extends EditorAction {
	constructor() {
		super({
			id: 'leap.projectionBoxes.toggle',
			label: 'Toggle Projection Boxes',
			alias: 'Toggle Projection Boxes',
			precondition: undefined,
			kbOpts: {
				kbExpr: null,
				primary: KeyMod.Shift | KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyP,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): Promise<void> {
		const leap = Leap.get(editor);
		leap.toggleProjectionBoxes();
	}
}

// -------------------------------------
// Top-level stuff
// -------------------------------------

// Register the Leap class as a vscode
registerEditorContribution(Leap.ID, Leap);

// Register the Leap keybinding
registerEditorAction(LeapAction);

// Register the Leap Escape keybinding
registerEditorAction(LeapEscapeAction);

registerEditorAction(LeapExplainAction);

// Register the Leap keybinding for updating suggestion decoration
registerEditorAction(LeapDecorAction);

// toggling projection boxes
registerEditorAction(ProjectionBoxesAction);
