/**
 * Labelled inputs.
 *
 * The label is a real `<label>` bound by id rather than a placeholder, because a
 * placeholder disappears the moment someone starts typing and a teacher mid-lesson
 * should not have to delete text to remember what a box was for.
 *
 * `hint` is not-yet, never system-error. Validation messages here are things the person can fix,
 * which is "not yet", not a system failure.
 */

import { useId, useState } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

const BOX =
  'w-full rounded-lg bg-surface px-3 py-2 text-grape ring-1 ring-grape/20 placeholder:text-muted/60 focus:outline-2 focus:outline-offset-0 focus:outline-grape disabled:opacity-50'

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
      <label htmlFor={id} className="text-sm font-medium text-grape">
        {label}
      </label>
      <input id={id} {...rest} className={BOX} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-not-yet-ink">
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
      <label htmlFor={id} className="text-sm font-medium text-grape">
        {label}
      </label>
      <textarea
        id={id}
        {...rest}
        className={`${BOX} font-mono`}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-not-yet-ink">
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
      <label htmlFor={id} className="text-sm font-medium text-grape">
        {label}
      </label>
      <select id={id} {...rest} className={BOX}>
        {children}
      </select>
      {hint ? <p className="text-sm text-not-yet-ink">{hint}</p> : null}
    </div>
  )
}

/**
 * A password with a Show button. One field, not "type it twice": seeing what you typed
 * catches the typo a second box exists to catch, without making you type it twice.
 */
export function PasswordInput({
  label,
  hint,
  ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-grape">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          {...rest}
          type={shown ? 'text' : 'password'}
          className={`${BOX} pr-16`}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 rounded-r-lg px-3 text-sm font-medium text-muted hover:text-grape focus-visible:outline-2 focus-visible:outline-grape"
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-not-yet-ink">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
