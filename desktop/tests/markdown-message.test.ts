import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "../src/renderer/src/MarkdownMessage";

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownMessage, { content }));
}

describe("desktop markdown messages", () => {
  it("restores headings, emphasis, lists, fenced code, and GFM tables", () => {
    const html = render(`# Result

This is **important**.

- first
- second

\`\`\`ts
const answer = 42;
\`\`\`

| Name | State |
| --- | --- |
| Magi | ready |`);

    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain("<strong>important</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<code class="language-ts">const answer = 42;</code>');
    expect(html).toContain("<table>");
  });

  it("does not render raw HTML or unsafe links", () => {
    const html = render(
      '<script>alert(1)</script>\n\n[run](javascript:alert(2)) [http](http://example.com)'
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="http://example.com"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('class="markdown-unsafe-link"');
  });

  it("allows only https links to open outside the app", () => {
    const html = render("[Magi](https://example.com/docs) [local](./README.md)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('href="./README.md"');
  });
});
