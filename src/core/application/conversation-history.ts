export interface ConversationExchange {
  question: string;
  answer: string;
}

// Complete recent exchanges avoid sending orphaned replies or splitting Unicode text.
export function selectHistory(history: readonly ConversationExchange[]): {
  exchanges: ConversationExchange[]; omitted: number;
} {
  const exchanges: ConversationExchange[] = [];
  for (const exchange of [...history].reverse()) {
    if (exchanges.length === 6) break;
    const candidate = [exchange, ...exchanges];
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > 12000) break;
    exchanges.unshift({ question: exchange.question, answer: exchange.answer });
  }
  return { exchanges, omitted: history.length - exchanges.length };
}
