/**
 * Question prompts are stored as `{ blocks: [...] }` (paragraph / equation /
 * table / image references). Every reader that needs plain text — the
 * booklet, the evaluator screen, the server-rendered PDF — goes through this
 * one function, so a prompt never renders as "[object Object]" anywhere.
 */
export function promptText(prompt: unknown): string {
  if (prompt == null) return '';
  if (typeof prompt === 'string') return prompt;
  const blocks = (prompt as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return '';
  const lines: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const text = typeof block['text'] === 'string' ? block['text'] : typeof block['content'] === 'string' ? block['content'] : typeof block['latex'] === 'string' ? block['latex'] : '';
    if (text) lines.push(text);
    else if (block['kind'] === 'image' || block['type'] === 'image') lines.push(typeof block['alt'] === 'string' ? `[image: ${block['alt']}]` : '[image]');
  }
  return lines.join('\n');
}
