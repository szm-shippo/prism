import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { CitedAnswer } from '../core/application/citation-answerer';

export const CHAT_VIEW_TYPE = 'prism-chat';

export class PrismChatView extends ItemView {
  private pending = false;
  private requestId = 0;

  constructor(leaf: WorkspaceLeaf, private readonly answer: (query: string) => Promise<CitedAnswer>) {
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
    this.contentEl.createEl('h2', { text: 'Ask Prism' });
    const form = this.contentEl.createEl('form');
    const label = form.createEl('label', { text: 'Question' });
    const query = label.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask about your Vault Markdown' },
    });
    const submit = form.createEl('button', { text: 'Ask' });
    submit.type = 'submit';
    const status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    const response = this.contentEl.createDiv();
    response.style.whiteSpace = 'pre-wrap';
    const sources = this.contentEl.createDiv();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return this.submit(query, submit, status, response, sources);
    });
  }

  async onClose(): Promise<void> {
    this.requestId += 1;
    this.pending = false;
  }

  private async submit(
    query: HTMLTextAreaElement,
    button: HTMLButtonElement,
    status: HTMLElement,
    response: HTMLDivElement,
    sources: HTMLDivElement,
  ): Promise<void> {
    if (this.pending) return;
    const question = query.value.trim();
    if (!question) {
      status.textContent = 'Enter a question.';
      query.focus();
      return;
    }
    const request = ++this.requestId;
    this.pending = true;
    button.disabled = true;
    status.textContent = 'Answering…';
    response.empty();
    sources.empty();
    try {
      const answer = await this.answer(question);
      if (request !== this.requestId) return;
      response.textContent = answer.content;
      if (answer.citations.length > 0) {
        sources.createEl('h3', { text: 'Sources' });
        const list = sources.createEl('ol');
        for (const citation of answer.citations) {
          list.createEl('li', {
            text: `${citation.path} (lines ${citation.startLine}–${citation.endLine})`,
          });
        }
      }
      status.textContent = 'Answer ready.';
    } catch {
      if (request === this.requestId) {
        status.textContent = 'Could not answer. Check provider settings, indexing, and network, then retry.';
      }
    } finally {
      if (request === this.requestId) {
        this.pending = false;
        button.disabled = false;
      }
    }
  }
}
