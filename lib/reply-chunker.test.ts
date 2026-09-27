import { describe, expect, it } from "vitest";

import { ReplyChunker } from "./reply-chunker";

function setup(minChunk = 40) {
  const sent: string[] = [];
  const c = new ReplyChunker(async (t) => {
    sent.push(t);
  }, { minChunk });
  return { c, sent };
}

// Feed text in small pieces, like a token stream.
function stream(c: ReplyChunker, text: string, size = 3) {
  for (let i = 0; i < text.length; i += size) c.push(text.slice(i, i + size));
}

describe("ReplyChunker", () => {
  it("keeps a one-paragraph reply as the final message", async () => {
    const { c, sent } = setup();
    stream(c, "You have three rooms: Garage, Primary suite, Game room.");
    await c.drain();
    expect(sent).toEqual([]);
    expect(c.takeRemainder()).toBe("You have three rooms: Garage, Primary suite, Game room.");
  });

  it("sends the opening paragraph as soon as it's complete, then batches", async () => {
    const { c, sent } = setup(40);
    stream(c, "On it — here's the week.\n\n*Mon* dentist 9am\n\n*Tue* nothing\n\n*Wed* flight to Austin at 7:15am\n\n*Thu* ");
    await c.drain();
    expect(sent[0]).toBe("On it — here's the week.");
    // Later paragraphs wait until they add up to minChunk.
    expect(sent[1]).toBe("*Mon* dentist 9am\n\n*Tue* nothing\n\n*Wed* flight to Austin at 7:15am");
    stream(c, "free\n\nThat's it.");
    await c.drain();
    expect(sent).toHaveLength(2);
    expect(c.takeRemainder()).toBe("*Thu* free\n\nThat's it.");
  });

  it("flushes a tool-turn preamble and keeps lists intact", async () => {
    const { c, sent } = setup();
    stream(c, "Let me check the calendar.");
    c.flush();
    stream(c, "Done:\n• one\n• two");
    await c.drain();
    expect(sent).toEqual(["Let me check the calendar."]);
    expect(c.takeRemainder()).toBe("Done:\n• one\n• two");
    expect(c.sent).toBe(1);
  });

  it("delivers in order even when sends are slow", async () => {
    const sent: string[] = [];
    const c = new ReplyChunker(
      (t) => new Promise((r) => setTimeout(() => (sent.push(t), r()), t.startsWith("A") ? 20 : 1)),
      { minChunk: 1 },
    );
    c.push("A first\n\nB second\n\nC third");
    c.flush();
    await c.drain();
    expect(sent).toEqual(["A first", "B second", "C third"]);
  });
});
