import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react'

/**
 * The settings panel's own controls, all of the board's stationery: ink and paper buttons,
 * hairline-ruled fields, a choice of chips and a switch, each with the indigo-ink focus ring.
 * Nothing here is a browser default.
 */

export function Button({
  tone = 'ink',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'ink' | 'quiet' | 'danger' }) {
  return (
    <button
      type="button"
      {...rest}
      className={`settings-button${className ? ` ${className}` : ''}`}
      data-tone={tone}
    />
  )
}

/** A download link styled as a button; the browser saves the attachment. */
export function DownloadLink({
  href,
  tone = 'ink',
  children,
}: {
  href: string
  tone?: 'ink' | 'quiet'
  children: ReactNode
}) {
  return (
    <a className="settings-button" data-tone={tone} href={href} download>
      {children}
    </a>
  )
}

export function TextField({
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
  describedBy,
}: {
  label: string
  type: 'email' | 'password' | 'text'
  value: string
  onChange(value: string): void
  autoComplete: string
  hint?: string
  describedBy?: string
}) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        {label}
      </label>
      <input
        className="settings-input"
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
        aria-describedby={
          [hint ? hintId : null, describedBy].filter(Boolean).join(' ') || undefined
        }
      />
      {hint && (
        <p className="settings-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

/** One of a few choices, as chips: real radio buttons, so the arrow keys move between them. */
export function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  hint,
  onChange,
}: {
  legend: string
  name: string
  value: T
  options: readonly { value: T; label: string }[]
  /** A line under the choices, which the group is described by. */
  hint?: string
  onChange(value: T): void
}) {
  const id = useId()
  return (
    <fieldset className="settings-choice" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="settings-label">{legend}</legend>
      <div className="settings-chips">
        {options.map((o) => (
          <label className="settings-chip" key={o.value}>
            <input
              className="settings-chip-input"
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="settings-chip-face">{o.label}</span>
          </label>
        ))}
      </div>
      {hint && (
        <p className="settings-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </fieldset>
  )
}

/**
 * A question asked in place, on the paper it came from: the words, then its answers. The screen
 * reader reads it out as it appears. Focus goes to its first button (the safe answer comes
 * first) and returns to where it was when the question goes; Esc answers `onCancel` before the
 * panel hears it.
 */
export function Ask({
  children,
  buttons,
  onCancel,
  tone = 'plain',
}: {
  children: ReactNode
  buttons: ReactNode
  onCancel(): void
  tone?: 'plain' | 'danger'
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const from = document.activeElement
    box.current?.querySelector<HTMLElement>('button:not(:disabled), input')?.focus()
    return () => {
      // The control that asked may be gone by now (it swaps for the answer): then nothing moves.
      if (from instanceof HTMLElement && from.isConnected) from.focus()
    }
  }, [])
  return (
    <div
      ref={box}
      className="settings-ask"
      role="alertdialog"
      aria-label="Please confirm"
      data-tone={tone}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <p className="settings-ask-text">{children}</p>
      <div className="settings-actions">{buttons}</div>
    </div>
  )
}

/** A reserved, polite line for what just happened or went wrong. */
export function Message({ tone, children }: { tone?: 'error' | 'notice'; children?: ReactNode }) {
  return (
    <p className="settings-message" aria-live="polite" data-tone={children ? tone : undefined}>
      {children}
    </p>
  )
}
