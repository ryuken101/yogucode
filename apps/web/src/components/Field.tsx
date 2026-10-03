/**
 * Labelled inputs.
 *
 * The label is a real `<label>` bound by id rather than a placeholder, because a
 * placeholder disappears the moment someone starts typing and a teacher mid-lesson
 * should not have to delete text to remember what a box was for.
 *
 * `hint` is amber, never rust. Validation messages here are things the person can fix,
 * which is "not yet", not a system failure.
 */

import { useId } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

const BOX =
  'w-full rounded-lg bg-paper px-3 py-2 text-ink ring-1 ring-ink/15 placeholder:text-ink-soft/60 focus:outline-2 focus:outline-offset-0 focus:outline-sky disabled:opacity-50'

interface Common {
  label: string
  hint?: string | null
}

export function TextInput({
  label,
  hint,
  ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input id={id} {...rest} className={BOX} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-amber">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Textarea({
  label,
  hint,
  ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <textarea
        id={id}
        {...rest}
        className={`${BOX} font-mono`}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-amber">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Select({
  label,
  hint,
  children,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <select id={id} {...rest} className={BOX}>
        {children}
      </select>
      {hint ? <p className="text-sm text-amber">{hint}</p> : null}
    </div>
  )
}
