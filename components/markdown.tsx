import ReactMarkdown from "react-markdown";

/**
 * Renders a markdown string as formatted HTML with Tailwind typography.
 * Used for all "notes" fields across the app. Falls back to null if
 * content is empty/null.
 */
export function Markdown({ content, className }: { content: string | null | undefined; className?: string }) {
  if (!content) return null;
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className ?? ""}`}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
