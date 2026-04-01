import { describe, expect, it } from "vitest";

import { parseTranscriptMessageBlocks, tokenizeTranscriptLinks } from "./transcriptMessageFormatting";

describe("parseTranscriptMessageBlocks", () => {
  it("extracts markdown tables from surrounding text", () => {
    const blocks = parseTranscriptMessageBlocks([
      "before",
      "| Name | Value |",
      "| :--- | ---: |",
      "| Alpha | 1 |",
      "| Beta | 2 |",
      "after",
    ].join("\n"));

    expect(blocks).toEqual([
      { kind: "text", text: "before" },
      {
        kind: "table",
        table: {
          headers: ["Name", "Value"],
          alignments: ["left", "right"],
          rows: [
            ["Alpha", "1"],
            ["Beta", "2"],
          ],
        },
      },
      { kind: "text", text: "after" },
    ]);
  });

  it("reuses cached block parsing for identical message text", () => {
    const text = [
      "before",
      "| Name | Value |",
      "| :--- | ---: |",
      "| Alpha | 1 |",
      "after",
    ].join("\n");

    const first = parseTranscriptMessageBlocks(text);
    const second = parseTranscriptMessageBlocks(text);

    expect(second).toBe(first);
  });
});

describe("tokenizeTranscriptLinks", () => {
  it("detects markdown and bare url links", () => {
    const tokens = tokenizeTranscriptLinks("See [docs](https://example.com) and https://github.com/example/repo");

    expect(tokens).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "docs", href: "https://example.com", linkKind: "url" },
      { kind: "text", text: " and " },
      {
        kind: "link",
        text: "https://github.com/example/repo",
        href: "https://github.com/example/repo",
        linkKind: "url",
      },
    ]);
  });

  it("reuses cached link tokenization for identical text", () => {
    const text = "See [docs](https://example.com) and https://github.com/example/repo";

    const first = tokenizeTranscriptLinks(text);
    const second = tokenizeTranscriptLinks(text);

    expect(second).toBe(first);
  });
});
