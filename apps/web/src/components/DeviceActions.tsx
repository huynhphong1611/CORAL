import { protocol } from '@coral/shared'
import { useState, type FormEvent } from 'react'
import { en } from '../i18n/en'
import { buttonClass, inputClass } from './ui'

/**
 * The device buttons of FR-008 — Back, Home, Hide keyboard, Restart app — typing into the focused
 * field, and a secret by name for password fields (FR-014): for live control (US3) and the
 * Recorder (US4), which decides what each command does.
 */
export function DeviceActions({
  send,
}: {
  send: (command: protocol.DeviceCommand) => void | Promise<void>
}) {
  const [text, setText] = useState('')
  const [secret, setSecret] = useState('')

  const button = (label: string, command: protocol.DeviceCommand) => (
    <button type="button" className={buttonClass.secondary} onClick={() => void send(command)}>
      {label}
    </button>
  )

  function typeText(event: FormEvent) {
    event.preventDefault()
    if (!text) return
    void send({ kind: 'type', text })
    setText('')
  }
  function typeSecret(event: FormEvent) {
    event.preventDefault()
    if (protocol.SECRET_NAME_PATTERN.test(secret)) void send({ kind: 'type', secret })
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {button(en.control.back, { kind: 'back' })}
        {button(en.control.home, { kind: 'home' })}
        {button(en.control.hideKeyboard, { kind: 'hide_keyboard' })}
        {button(en.control.restartApp, { kind: 'restart_app' })}
      </div>
      <form onSubmit={typeText} className="flex gap-2">
        <input
          aria-label={en.control.typeText}
          placeholder={en.control.typePlaceholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="submit" className={buttonClass.secondary} disabled={!text}>
          {en.control.send}
        </button>
      </form>
      <form onSubmit={typeSecret} className="space-y-1">
        <div className="flex gap-2">
          <input
            aria-label={en.control.secret}
            placeholder={en.control.secretPlaceholder}
            value={secret}
            onChange={(e) => setSecret(e.target.value.toUpperCase())}
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          />
          <button
            type="submit"
            className={buttonClass.secondary}
            disabled={!protocol.SECRET_NAME_PATTERN.test(secret)}
          >
            {en.control.typeSecret}
          </button>
        </div>
        <p className="text-xs text-slate-500">{en.control.secretHint}</p>
      </form>
    </>
  )
}
