/**
 * A problem prompt, rendered.
 *
 * `react-markdown` without `rehype-raw`, so HTML in a prompt is shown as text rather than
 * parsed. Prompts are written by teachers, but they are read by children on their own
 * laptops — nothing a prompt contains should be able to put markup on that page.
 */

import ReactMarkdown from 'react-markdown'

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-prompt text-ink">
      <ReactMarkdown
        components={{
          p: (props) => <p className="my-2 leading-relaxed" {...props} />,
          ul: (props) => <ul className="my-2 list-disc pl-6" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal pl-6" {...props} />,
          h1: (props) => <h3 className="mt-4 mb-2 font-serif text-lg" {...props} />,
          h2: (props) => <h3 className="mt-4 mb-2 font-serif text-lg" {...props} />,
          h3: (props) => <h4 className="mt-3 mb-1 font-serif" {...props} />,
          a: (props) => (
            <a className="text-sky-deep underline" target="_blank" rel="noreferrer" {...props} />
          ),
          pre: (props) => (
            <pre
              className="my-3 overflow-x-auto rounded-lg bg-ink-deep p-3 font-mono text-sm text-cream"
              {...props}
            />
          ),
          code: ({ className, ...props }) =>
            className ? (
              <code className={`font-mono ${className}`} {...props} />
            ) : (
              <code className="rounded bg-sky-pale/50 px-1 font-mono text-[0.9em]" {...props} />
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
