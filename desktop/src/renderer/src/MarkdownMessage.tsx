import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="message-body markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const safeHref = externalHttpsUrl(href);
            return safeHref ? (
              <a href={safeHref} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span className="markdown-unsafe-link">{children}</span>
            );
          },
          img: ({ alt }) => <span className="markdown-image-label">📎 {alt || "Image"}</span>,
          code: ({ className, children }) => (
            <code className={className}>{cleanCodeChildren(children)}</code>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function externalHttpsUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanCodeChildren(children: ReactNode): ReactNode {
  if (typeof children !== "string") return children;
  return children.endsWith("\n") ? children.slice(0, -1) : children;
}
