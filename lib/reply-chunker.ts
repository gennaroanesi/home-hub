// Turns a streamed agent reply into a few WhatsApp messages instead of
// one late one: the opening paragraph goes out as soon as it's complete,
// later paragraphs are batched into ~minChunk-character messages, and
// whatever is left when the model finishes is the final message (which
// also carries any photos). Splits only on blank lines, so WhatsApp
// formatting (bold, lists) never gets cut in half.
//
// Text written before a tool call ("Let me check the calendar…") is
// flushed as its own message at the end of that model turn.

export interface ChunkerOptions {
  /** Batch size for chunks after the opening one. */
  minChunk?: number;
}

export class ReplyChunker {
  private buffer = "";
  private sentCount = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly minChunk: number;

  constructor(
    private readonly send: (text: string) => Promise<void>,
    opts: ChunkerOptions = {},
  ) {
    this.minChunk = opts.minChunk ?? 600;
  }

  /** Number of messages handed to `send` so far. */
  get sent(): number {
    return this.sentCount;
  }

  /** Feed streamed text. Sends complete paragraphs per the policy above. */
  push(delta: string): void {
    this.buffer += delta;
    const parts = this.buffer.split(/\n[ \t]*\n/);
    if (parts.length < 2) return; // no complete paragraph yet
    const tail = parts.pop()!; // still being written
    const complete = parts.map((p) => p.trim()).filter(Boolean);
    if (complete.length === 0) {
      this.buffer = tail;
      return;
    }
    if (this.sentCount === 0) {
      // Opening line: out immediately.
      this.enqueue(complete.shift()!);
    }
    const rest = complete.join("\n\n");
    if (rest.length >= this.minChunk) {
      this.enqueue(rest);
      this.buffer = tail;
    } else {
      // Not enough for a message yet — keep the complete paragraphs
      // buffered in front of the tail.
      this.buffer = rest ? `${rest}\n\n${tail}` : tail;
    }
  }

  /** End of a tool-using turn: send whatever is buffered. */
  flush(): void {
    const text = this.buffer.trim();
    this.buffer = "";
    if (text) this.enqueue(text);
  }

  /** End of the reply: the unsent remainder (becomes the final message). */
  takeRemainder(): string {
    const text = this.buffer.trim();
    this.buffer = "";
    return text;
  }

  /** Resolves when every queued send has finished (in order). */
  drain(): Promise<void> {
    return this.queue;
  }

  private enqueue(text: string): void {
    this.sentCount++;
    this.queue = this.queue.then(() => this.send(text)).catch((err) => {
      // Keep the chain alive; the final message still goes out.
      console.error("[reply-chunker] send failed:", err);
    });
  }
}
