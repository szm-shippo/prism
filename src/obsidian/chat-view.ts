import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { CitedAnswer, SourceCitation } from '../core/application/citation-answerer';
import { LLMProviderError } from '../core/provider/llm-provider';

export const CHAT_VIEW_TYPE = 'prism-chat';

function answerErrorMessage(error: unknown): string {
  if (error instanceof LLMProviderError) {
    return {
      authentication: 'Answer provider authentication failed. Reconnect it in Prism settings.',
      rate_limit: 'Answer provider rate limit or quota reached. Try again later.',
      unavailable: 'Answer provider or network is unavailable. Try again later.',
      invalid_request: 'Answer provider rejected the request. Check the selected model in Prism settings.',
      unknown: 'Answer provider returned an incomplete or invalid response.',
    }[error.code];
  }
  const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  if (typeof message === 'string') {
    if (message === 'Connect a ChatGPT account in Prism settings.' ||
        message === 'ChatGPT connection is not ready.') {
      return 'Connect or reconnect your ChatGPT account in Prism settings.';
    }
    if (message === 'Codex model list is unavailable.' ||
        message === 'Codex model list is invalid.' ||
        message === 'No Codex models are available to this account.') {
      return 'Could not load available Codex models. Check your ChatGPT connection and refresh models in Prism settings.';
    }
    if (message === 'Configure an LLM model and API key before asking Prism.') {
      return message;
    }
  }
  return 'Could not answer. Check provider settings, indexing, and network, then retry.';
}

export class PrismChatView extends ItemView {
  private pending = false;
  private requestId = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly answer: (query: string) => Promise<CitedAnswer>,
    private readonly openCitation: (citation: SourceCitation) => Promise<boolean>,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Prism Ask';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('prism-ask-view');
    this.contentEl.createEl('h2', { text: 'Ask Prism' });
    const conversation = this.contentEl.createDiv({ cls: 'prism-ask-conversation' });
    conversation.setAttribute('role', 'log');
    conversation.setAttribute('aria-label', 'Prism Ask conversation');
    const form = this.contentEl.createEl('form');
    form.addClass('prism-ask-form');
    const label = form.createEl('label', { text: 'Question' });
    const query = label.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask about your Vault Markdown' },
    });
    const submit = form.createEl('button', { text: 'Ask' });
    submit.type = 'submit';
    const inputStatus = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return this.submit(query, submit, inputStatus, conversation);
    });
  }

  async onClose(): Promise<void> {
    this.requestId += 1;
    this.pending = false;
  }

  private async submit(
    query: HTMLTextAreaElement,
    button: HTMLButtonElement,
    inputStatus: HTMLElement,
    conversation: HTMLDivElement,
  ): Promise<void> {
    if (this.pending) return;
    const question = query.value.trim();
    if (!question) {
      inputStatus.textContent = 'Enter a question.';
      query.focus();
      return;
    }
    const request = ++this.requestId;
    this.pending = true;
    button.disabled = true;
    inputStatus.textContent = '';
    conversation.empty();
    const turn = conversation.createDiv({ cls: 'prism-ask-turn' });
    turn.createEl('p', { cls: 'prism-ask-question', text: question });
    const response = turn.createDiv({ cls: 'prism-ask-answer' });
    const sources = turn.createDiv();
    const status = turn.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    status.textContent = 'Answering…';
    try {
      const answer = await this.answer(question);
      if (request !== this.requestId) return;
      this.renderAnswer(response, status, answer);
      if (answer.citations.length > 0) {
        sources.createEl('h3', { text: 'Sources' });
        const list = sources.createEl('ol');
        for (const citation of answer.citations) {
          const item = list.createEl('li');
          const link = item.createEl('button', {
            text: `${citation.path} (lines ${citation.startLine}–${citation.endLine})`,
          });
          link.type = 'button';
          link.addEventListener('click', () => this.openSource(citation, status));
        }
      }
      status.textContent = 'Answer ready.';
      conversation.scrollTop = conversation.scrollHeight;
    } catch (error) {
      if (request === this.requestId) {
        status.textContent = answerErrorMessage(error);
        conversation.scrollTop = conversation.scrollHeight;
      }
    } finally {
      if (request === this.requestId) {
        this.pending = false;
        button.disabled = false;
      }
    }
  }

  private renderAnswer(response: HTMLDivElement, status: HTMLElement, answer: CitedAnswer): void {
    const marker = /\[\^(\d+)\]/gu;
    let position = 0;
    for (const match of answer.content.matchAll(marker)) {
      const index = Number(match[1]) - 1;
      const citation = answer.citations[index];
      if (!citation) continue;
      response.createEl('span', { text: answer.content.slice(position, match.index) });
      const link = response.createEl('button', {
        text: match[0],
        attr: { 'aria-label': `Open source ${citation.path}, lines ${citation.startLine}–${citation.endLine}` },
      });
      link.type = 'button';
      link.addEventListener('click', () => this.openSource(citation, status));
      position = match.index + match[0].length;
    }
    response.createEl('span', { text: answer.content.slice(position) });
  }

  private async openSource(citation: SourceCitation, status: HTMLElement): Promise<void> {
    try {
      status.textContent = await this.openCitation(citation)
        ? 'Source opened.' : 'Source is unavailable. Check whether the note was moved, deleted, or excluded.';
    } catch {
      status.textContent = 'Could not open the source. Try again.';
    }
  }
}
