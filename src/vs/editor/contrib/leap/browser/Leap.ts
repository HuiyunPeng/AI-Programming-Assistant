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
	private _panel: HTMLElement | undefined;
	private _mdRenderer: MarkdownRenderer;

	private _lastCompletions: Completion[] | undefined; // TODO (kas) This is a bad idea... we need to carefully think about how to handle state.
	// private _lastExplanations: string[] | undefined;
	// private _lastTestcases: string[] | undefined;
	private _lastPrompt: string | undefined;

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

			// Disable projection boxes if necessary.
			this._projectionBoxes.studyGroup = this._config.group;
			// NOTE disabling projection boxes for now
			this._projectionBoxes.changeViewMode(ViewMode.Stealth);
			// if (this._config.group === StudyGroup.Control) {
			// }

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

	public dispose(): void {
		this._logger.panelClose();
		this._panel?.remove();
		this._panel = undefined;
	}

	public async toggle(): Promise<void> {
		// TODO (kas) We should probably think more carefully about the interface for interacting
		//  with leap. For now, this will do as a simple on-off toggle.
		this._abort.abort();
		const abort = new AbortController();
		this._abort = abort;

		switch (this.state) {
			case LeapState.Off:
			case LeapState.Loading:
				// Just start!
				this.state = LeapState.Loading;
				await this.initPanel();
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
		if (!this._panel) {
			const editor_div = this._editor.getDomNode();
			if (!editor_div) {
				throw new Error('Editor Div does not exist. This should not happen.');
			}

			this._panel = document.createElement('div');

			// Set the panel style
			this._panel.className = 'monaco-hover';
			this._panel.style.position = 'absolute';
			this._panel.style.top = '30px';
			this._panel.style.bottom = '14px';
			this._panel.style.right = '14px';
			this._panel.style.width = '600px';
			this._panel.style.padding = '10px';
			this._panel.style.transitionProperty = 'all';
			this._panel.style.transitionDuration = '0.2s';
			this._panel.style.transitionDelay = '0s';
			this._panel.style.transitionTimingFunction = 'ease';
			this._panel.style.overflowX = 'visible';
			// this._panel.style.overflowY = 'clip';
			this._panel.style.overflowY = 'auto';
			this._panel.onwheel = (e) => {
				e.stopImmediatePropagation();
			};
			this._panel.onmouseenter = (e) => {
				this.expandPanel();
			};
			this._panel.onmouseleave = (e) => {
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

			editor_div.appendChild(this._panel);
		}

		// NOTE: Technically this is never needed since we create panel only when toggling
		// when we toggle off, interestingly we delete the panel
		// Clear the panel content
		this.clearPanel();

		this._logger.panelOpen();

		return this._panel;
	}

	public compressPanel(): void {
		this._logger.panelUnfocus();

		if (this._panel) {
			this._panel.style.right = '-400px';
			this._panel!.style.zIndex = '0';
			this._panel.style.opacity = '0.3';
		}
	}

	public expandPanel(): void {
		this._logger.panelFocus();

		if (this._panel) {
			this._panel.style.right = '14px';
			this._panel!.style.zIndex = '1000';
			this._panel.style.opacity = '1';
		}
	}

	public async initPanel(): Promise<void> {
		// first, create the panel
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
		this._lastCompletions = await this.getCompletions(prefix, suffix);

		// display completions
		// show the first page of the completions
		this.displaySuggestion(0);

		// Finally, update the state.
		this.state = LeapState.Shown;
	}

	public getTextFromEditor(): { prefix: string; suffix: string } | void {
		this._lastCompletions = this._config?.completions?.map(code => new PythonCode(code));
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
		const prefix: string = model.getValueInRange(new Range(0, 0, this._lastCursorPos.lineNumber, this._lastCursorPos.column));
		const suffix: string = model.getValueInRange(new Range(this._lastCursorPos.lineNumber, this._lastCursorPos.column, lastLineIdx, lastLineWidth));

		return { prefix, suffix };
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
		// somewhat redundant, as we only do this once we create the panel
		this.clearPanel();

		const results: Completion[] = [];

		if (!this._panel) {
			console.error("no panel created");
			return results;
		}

		try {
			// Start by putting a progress bar in the panel
			const container = document.createElement('div');
			const title = document.createElement('h2');
			title.innerText = 'Getting suggestions. Please wait...';
			const barContainer = document.createElement('div');
			const progressBar = new ProgressBar(barContainer).total(10);
			const barElement = progressBar.getContainer();
			barElement.style.position = 'inherit';
			(barElement.firstElementChild! as HTMLElement).style.position = 'inherit';
			container.appendChild(title);
			container.appendChild(barContainer);
			this._panel.appendChild(container);

			// TODO (lisa) bad hack to get around the references to completions
			// progressBar.done();

			// request the completions
			this._lastPrompt = prefix;
			const modelRequest = await this._utils.buildRequest(prefix, suffix);
			this._logger.modelRequest(modelRequest);
			const codes: string[] = await this._utils.getCompletions(
				modelRequest,
				this._abort.signal,
				(_e) => progressBar.worked(1));

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
	 * Clears the panel of every single node, except for the compress/expand button
	 * @returns
	 */
	private async clearPanel() {
		if (!this._panel) {
			return;
		}
		// remove everything except the compress button, cuz we need to hide/expand panel
		// had issues with using foreach, led to some stuff being done async?
		// instead, gonna use a loop like this
		let child = this._panel.firstElementChild;
		while (child) {
			const nextChild = child.nextElementSibling;
			if (child.id !== "compress-button") {
				this._panel.removeChild(child);
			}
			child = nextChild;
		}
	}

	/**
	 * Displays a suggestion page, which the full code completion and other actions for this particular completion
	 *
	 * @param index The index of the completions array to display this suggestion for
	 * @returns
	 */
	private async displaySuggestion(index: number) {
		if (!this._panel) {
			console.error('displaySuggestion called with no panel! Index: ', index);
			return;
		}

		if (!this._lastCompletions ||
			this._lastCompletions.length <= index) {
			console.error('displaySuggestion called with invalid index. Ignoring: ', index);
			return;
		}

		this.clearPanel();
		this.renderNavigation(index);

		const completion = this._lastCompletions[index];

		// show errors
		if (completion instanceof ErrorMessage) {
			this.renderError(index, completion);
			return;
		}

		// must be instance of PythonCode (python completion snippet)
		this.renderPython(index, completion);
	}

	/**
	 * Renders an error message page
	 *
	 * @param index
	 * @param error
	 * @returns
	 */
	private renderError(index: number, error: ErrorMessage) {
		if (!this._panel) {
			console.error('renderError called with no panel! Index: ', index);
			return;
		}

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

		this._panel.appendChild(block);
	}

	/**
	 * Renders a code completion page, with available actions for this particular completion
	 *
	 * @param index
	 * @param code
	 * @returns
	 */
	private renderPython(index: number, code: PythonCode) {
		if (!this._panel) {
			console.error('renderPython called with no panel! Index: ', index);
			return;
		}

		const block = document.createElement('div');
		block.style.marginBottom = '20px';

		// First, append the title
		const title = document.createElement('h2');
		setInner(title, `Suggestion ${index + 1}`);
		block.appendChild(title);

		// Then the links we use to communicate!
		// TODO could wrap links in div, good ol web dev standards
		// might need it anyways, to link up with the actual completion div later created?
		const previewLink = document.createElement('a');
		previewLink.textContent = "Copy to Editor";
		previewLink.className = "monaco-button monaco-text-button";
		previewLink.style.color = "white";
		previewLink.style.display = "inline-block";
		previewLink.style.width = "100px";
		previewLink.style.backgroundColor = "rgb(14, 99, 156)";
		previewLink.onclick = (_) => {
			this.previewCompletion(index);
			this.compressPanel();
		};
		block.appendChild(previewLink);

		const revertLink = document.createElement('a');
		revertLink.textContent = "Revert";
		revertLink.className = "monaco-button monaco-text-button";
		revertLink.style.marginLeft = "12px";
		revertLink.style.display = "inline";
		revertLink.onclick = (_) => {
			this.removeCompletion(false);
		};
		block.appendChild(revertLink);

		let completion = code.code;

		// Prepend whitespace if necessary
		if (this._lastCursorPos?.column) {
			completion = ' '.repeat(this._lastCursorPos.column - 1) + completion;
		}

		// add the code block itself
		const md = new MarkdownString();
		md.appendCodeblock("python", completion);

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

		const actionButtonsDiv = document.createElement("div");
		actionButtonsDiv.style.display = "flex";
		actionButtonsDiv.style.flexDirection = "row";
		actionButtonsDiv.style.alignItems = "center";
		actionButtonsDiv.style.gap = "12px";
		block.appendChild(actionButtonsDiv);

		const explanationDiv = document.createElement("div");
		explanationDiv.style.marginTop = "10px";
		block.appendChild(explanationDiv);

		const testcasesDiv = document.createElement("div");
		testcasesDiv.style.marginTop = "10px";
		testcasesDiv.style.marginBottom = "30px";
		block.appendChild(testcasesDiv);

		const explainLink = document.createElement('a');
		explainLink.textContent = "Explain";
		explainLink.className = "monaco-button monaco-text-button";
		explainLink.style.color = "white";
		explainLink.style.display = "block";
		explainLink.style.width = "60px";
		explainLink.style.backgroundColor = "rgb(14, 99, 156)";
		explainLink.onclick = (_) => {
			this.explainCompletion(index, explanationDiv);
		};
		actionButtonsDiv.appendChild(explainLink);

		const exampleTestsLink = document.createElement('a');
		exampleTestsLink.textContent = "Example Tests";
		exampleTestsLink.className = "monaco-button monaco-text-button";
		exampleTestsLink.style.color = "white";
		exampleTestsLink.style.display = "block";
		exampleTestsLink.style.width = "100px";
		exampleTestsLink.style.backgroundColor = "rgb(14, 99, 156)";
		exampleTestsLink.onclick = (_) => {
			// this.explainCompletion(index);
			// TODO testcases
		};
		actionButtonsDiv.appendChild(exampleTestsLink);

		this._panel.appendChild(block);
	}


	private renderNavigation(index: number) {
		if (!this._panel) {
			console.error('renderNavigation called with no panel! Index: ', index);
			return;
		}

		if (!this._lastCompletions || this._lastCompletions.length <= 1) {
			return;
		}
		const div = document.createElement("div");
		div.style.display = "flex";
		div.style.flexDirection = "center";
		div.style.alignItems = "center";
		div.style.gap = "6px";

		const prevLink = document.createElement("a");
		prevLink.textContent = "< Prev";
		prevLink.onclick = (() => {
			this.displaySuggestion(Math.max(index - 1, 0));
		});
		prevLink.style.opacity = index === 0 ? '0.6' : '1';
		div.appendChild(prevLink);

		const pageNumber = document.createElement("p");
		pageNumber.textContent = `${index + 1} / ${this._lastCompletions.length}`;
		pageNumber.style.margin = "0";
		div.appendChild(pageNumber);

		const nextLink = document.createElement("a");
		nextLink.textContent = "Next >";
		nextLink.onclick = (() => {
			if (this._lastCompletions) {
				this.displaySuggestion(Math.min(index + 1, this._lastCompletions.length - 1));
			}
		});
		nextLink.style.opacity = index === this._lastCompletions.length - 1 ? '0.6' : '1';
		div.appendChild(nextLink);

		this._panel.appendChild(div);
	}


	public hideCompletions(commentOnly: boolean = true): void {
		// TODO do we really want to delete everything when we hide completions?
		// first, hide the exploration panel
		this.dispose();

		// second, clean up the comment markups
		// if commentOnly is true, we only remove the comments
		this.removeCompletion(commentOnly);
	}

	// TODO don't pass in explanation div, not very scalable i think
	private async explainCompletion(index: number, explanationDiv: HTMLElement) {
		if (!this._lastCompletions ||
			this._lastCompletions.length <= index) {
			console.error('explainCompletion called with invalid index. Ignoring: ', index);
			return;
		}

		const completion = this._lastCompletions[index];
		if (!(completion instanceof PythonCode)) {
			console.error(`explainCompletion called with index ${index}, but entry is an error:\n${completion.message}`);
			return;
		}

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
		explanationDiv.appendChild(container);

		const codeText = completion.code;
		const explanation = await this._utils.getExplanationsForCode(
			codeText,
			this._lastPrompt ?? "",
			this._abort.signal,
			(_e) => progressBar.worked(1)
		);
		// TODO cache explanation,

		progressBar.dispose();
		container.remove();

		console.log("got", explanation);
		const block = document.createElement('div');

		const title = document.createElement('h3');
		title.textContent = "High Level Explanation";
		block.appendChild(title);

		const md = new MarkdownString();
		md.appendMarkdown(explanation);
		block.append(this._mdRenderer.render(md).element);

		explanationDiv.appendChild(block);
	}

	private previewCompletion(index: number) {
		// TODO (kas) error handling.
		if (!this._lastCompletions ||
			this._lastCompletions.length <= index) {
			console.error('previewCompletion called with invalid index. Ignoring: ', index);
			return;
		}

		const completion = this._lastCompletions[index];
		if (!(completion instanceof PythonCode)) {
			console.error(`previewCompletion called with index ${index}, but entry is an error:\n${completion.message}`);
			return;
		}

		this._logger.preview(index, completion.code);

		// TODO (kas) for now, we're assuming that we are indenting with spaces.
		const code =
			Leap.completionComment + '\n' +
			' '.repeat(this._lastCursorPos!.column - 1) + completion.code + '\n' +
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
	}

	private removeCompletion(commentOnly: boolean = true): void {
		// TODO (lisa) error handling.
		if (!this._lastCompletions) {
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

// -------------------------------------
// Top-level stuff
// -------------------------------------

// Register the Leap class as a vscode
registerEditorContribution(Leap.ID, Leap);

// Register the Leap keybinding
registerEditorAction(LeapAction);

// Register the Leap Escape keybinding
registerEditorAction(LeapEscapeAction);

// Register the Leap keybinding for updating suggestion decoration
registerEditorAction(LeapDecorAction);
