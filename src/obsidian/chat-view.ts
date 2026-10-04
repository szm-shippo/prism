import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { CitedAnswer, SourceCitation } from '../core/application/citation-answerer';
import { LLMProviderError } from '../core/provider/llm-provider';
import { LocalEmbeddingError } from '../core/provider/local-embedding-error';
import { selectHistory, type ConversationExchange } from '../core/application/conversation-history';

interface ChatTurn {
  question: string;
  answer?: CitedAnswer;
  error?: string;
  omitted: number;
}

export const CHAT_VIEW_TYPE = 'prism-chat';

function answerErrorMessage(error: unknown): string {
  if (error instanceof LocalEmbeddingError) return error.message;
  if (error instanceof LLMProviderError) {
    return {
      authentication: 'Answer provider authentication failed. Reconnect it in Prism settings.',
      rate_limit: 'Answer provider rate limit reached. Try again later.',
      quota: 'Answer provider usage quota reached. Check your account usage.',
      usage_limit: 'Answer provider rate limit or quota reached. Check your account usage or try again later.',
      context_limit: 'Input or context is too long. Shorten your question or start a new conversation.',
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
  private readonly turns: ChatTurn[] = [];
  private conversation?: HTMLDivElement;
  private query?: HTMLTextAreaElement;
  private button?: HTMLButtonElement;
  private reset?: HTMLButtonElement;
  private currentStatus?: HTMLElement;
  private draft = '';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly answer: (query: string, history: readonly ConversationExchange[]) => Promise<CitedAnswer>,
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
    Object.assign(this.contentEl.style, {
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
      height: '100%', minHeight: '0', minWidth: '0', overflow: 'hidden', overflowWrap: 'anywhere',
    });
    const heading = this.contentEl.createEl('h2', { text: 'Ask Prism' });
    heading.style.flex = 'none';
    const reset = this.contentEl.createEl('button', { text: 'New conversation' });
    reset.type = 'button';
    reset.style.flex = 'none';
    this.reset = reset;
    reset.addEventListener('click', () => {
      if (this.pending) return;
      this.turns.length = 0;
      this.draft = '';
      query.value = '';
      inputStatus.textContent = '';
      this.renderConversation();
      query.focus();
    });
    const disclosure = this.contentEl.createEl('details');
    disclosure.createEl('summary', { text: 'Data sent: questions, answers and retrieved Vault text to your selected LLM connection' });
    disclosure.createEl('p', {
      text: 'Your question, retrieved Vault text and source IDs, and up to 6 recent question/answer pairs (12,000 UTF-8 bytes) are sent to the LLM connection selected in Prism settings: OpenAI API (api.openai.com) or ChatGPT/Codex (chatgpt.com). Search runs on this device. Conversation stays in this view and is not saved to Markdown.',
    });
    Object.assign(disclosure.style, { flex: 'none', maxHeight: '25%', overflowY: 'auto' });
    const conversation = this.contentEl.createDiv({ cls: 'prism-ask-conversation' });
    this.conversation = conversation;
    Object.assign(conversation.style, {
      flex: '1 1 auto', minHeight: '0', overflowY: 'auto', overflowWrap: 'anywhere',
    });
    conversation.setAttribute('role', 'log');
    conversation.setAttribute('aria-label', 'Prism Ask conversation');
    this.currentStatus = this.contentEl.createEl('p', {
      cls: 'prism-ask-current-status',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    Object.assign(this.currentStatus.style, {
      flex: '0 0 auto', maxHeight: '20%', overflowY: 'auto', overflowWrap: 'anywhere', margin: '8px 0',
    });
    const form = this.contentEl.createEl('form');
    form.addClass('prism-ask-form');
    Object.assign(form.style, { flex: 'none', maxHeight: '50%', overflowY: 'auto' });
    const label = form.createEl('label', { text: 'Question' });
    Object.assign(label.style, { display: 'block', width: '100%', boxSizing: 'border-box' });
    const query = label.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask about your Vault Markdown' },
    });
    this.query = query;
    query.value = this.draft;
    query.addEventListener('input', () => { this.draft = query.value; });
    Object.assign(query.style, {
      display: 'block', width: '100%', boxSizing: 'border-box',
      maxHeight: '30vh', resize: 'vertical',
    });
    const submit = form.createEl('button', { text: 'Ask' });
    this.button = submit;
    submit.type = 'submit';
    const inputStatus = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      return this.submit(query, inputStatus);
    });
    this.renderConversation();
  }

  async onClose(): Promise<void> {
    this.draft = this.query?.value ?? this.draft;
    this.conversation = undefined;
    this.query = undefined;
    this.button = undefined;
    this.reset = undefined;
    this.currentStatus = undefined;
  }

  private async submit(
    query: HTMLTextAreaElement,
    inputStatus: HTMLElement,
  ): Promise<void> {
    if (this.pending) return;
    const question = query.value.trim();
    if (!question) {
      inputStatus.textContent = 'Enter a question.';
      query.focus();
      return;
    }
    inputStatus.textContent = '';
    this.draft = query.value;
    const turn: ChatTurn = { question, omitted: 0 };
    this.turns.push(turn);
    await this.requestAnswer(turn);
  }

  private async requestAnswer(turn: ChatTurn): Promise<void> {
    if (this.pending) return;
    const history = selectHistory(this.turns.slice(0, this.turns.indexOf(turn)).flatMap((previous) =>
      previous.answer && !previous.answer.incompleteReason && !previous.error
        ? [{ question: previous.question, answer: previous.answer.content }] : []));
    turn.omitted = history.omitted;
    turn.error = undefined;
    this.pending = true;
    this.renderConversation();
    try {
      turn.answer = await this.answer(turn.question, history.exchanges);
      if (turn.answer.incompleteReason) {
        turn.error = turn.answer.incompleteReason === 'output_limit'
          ? 'Answer incomplete: output token limit reached. Ask for a shorter answer.'
          : 'Answer incomplete: the provider stopped before completion. Retry or check provider settings.';
        return;
      }
      if ((this.query?.value ?? this.draft).trim() === turn.question) {
        this.draft = '';
        if (this.query) this.query.value = '';
      }
    } catch (error) {
      turn.error = answerErrorMessage(error);
    } finally {
      this.pending = false;
      this.renderConversation();
    }
  }

  private renderConversation(): void {
    const conversation = this.conversation;
    if (!conversation) return;
    if (this.button) this.button.disabled = this.pending;
    if (this.query) this.query.disabled = this.pending;
    if (this.reset) this.reset.disabled = this.pending;
    const latest = this.turns.at(-1);
    if (this.currentStatus) {
      const state = this.pending ? 'pending' : latest?.error ? 'failed' : latest?.answer ? 'complete' : 'idle';
      this.currentStatus.setAttribute('data-state', state);
      this.currentStatus.textContent = state === 'pending' ? 'Answering… Waiting for an answer.'
        : state === 'failed' ? `Could not complete the answer. ${latest?.error}`
        : state === 'complete' ? 'Answer ready. Output complete.' : 'Ready for a question.';
    }
    conversation.empty();
    for (const [index, entry] of this.turns.entries()) {
      const turn = conversation.createDiv({ cls: 'prism-ask-turn' });
      Object.assign(turn.style, {
        display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', minWidth: '0',
      });
      const user = this.createMessage(turn, 'You');
      const question = user.createEl('p', { cls: 'prism-ask-question', text: entry.question });
      Object.assign(question.style, { margin: '0', whiteSpace: 'pre-wrap' });
      const assistant = this.createMessage(turn, 'Prism');
      const response = assistant.createDiv({ cls: 'prism-ask-answer' });
      response.style.whiteSpace = 'pre-wrap';
      const sources = turn.createDiv();
      const status = turn.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
      const sourceStatus = turn.createEl('p', {
        cls: 'prism-ask-source-status', attr: { role: 'status', 'aria-live': 'polite' },
      });
      sourceStatus.style.margin = '0';
      if (entry.omitted > 0) turn.createEl('p', {
        text: `${entry.omitted} earlier question/answer pairs omitted from this request's context.`,
      });
      if (entry.answer) {
        this.renderAnswer(response, sourceStatus, entry.answer);
      }
      status.textContent = this.pending && index === this.turns.length - 1 ? 'Answering…'
        : entry.error ?? (entry.answer ? 'Answer ready.' : 'Answering…');
      if (entry.error && index === this.turns.length - 1) {
        const retry = turn.createEl('button', { text: 'Retry' });
        retry.type = 'button';
        retry.disabled = this.pending;
        retry.addEventListener('click', () => this.requestAnswer(entry));
      }
      if (entry.answer && entry.answer.citations.length > 0) {
        sources.createEl('h3', { text: 'Sources' });
        const list = sources.createEl('ol');
        for (const citation of entry.answer.citations) {
          const item = list.createEl('li');
          const link = item.createEl('button', {
            text: `${citation.path} (lines ${citation.startLine}–${citation.endLine})`,
          });
          link.type = 'button';
          Object.assign(link.style, { maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' });
          link.addEventListener('click', () => this.openSource(citation, sourceStatus));
        }
      }
    }
    conversation.scrollTop = conversation.scrollHeight;
  }

  private createMessage(turn: HTMLDivElement, speaker: 'You' | 'Prism'): HTMLDivElement {
    const message = turn.createDiv({
      cls: speaker === 'You' ? 'prism-ask-user-message' : 'prism-ask-assistant-message',
      attr: { role: 'group', 'aria-label': speaker },
    });
    Object.assign(message.style, {
      alignSelf: speaker === 'You' ? 'flex-end' : 'flex-start',
      boxSizing: 'border-box', minWidth: '0', maxWidth: '90%',
      padding: '10px 12px', borderRadius: '12px',
      border: '1px solid var(--background-modifier-border)',
      backgroundColor: speaker === 'You' ? 'var(--background-secondary)' : 'var(--background-primary)',
      color: 'var(--text-normal)', overflowWrap: 'anywhere',
    });
    return message;
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
