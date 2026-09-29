import { protocol, type api } from '@coral/shared'
import { useState, type FormEvent } from 'react'
import type { useControl } from '../api/control'
import { en } from '../i18n/en'
import { buttonClass, Card, inputClass, useNow } from './ui'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/**
 * Take / release a device and the buttons of FR-008 (US3): Back, Home, Hide keyboard, Restart app,
 * typing into the focused field, or a secret by name for password fields (FR-014). Viewers only
 * see who controls the device.
 */
export function ControlPanel({
  device,
  control,
  canWrite,
}: {
  device: api.DeviceView
  control: ReturnType<typeof useControl>
  canWrite: boolean
}) {
  const { mine, take, release, send, releaseAt, notice } = control
  const now = useNow(mine !== undefined)
  const [text, setText] = useState('')
  const [secret, setSecret] = useState('')
  const holder = device.activity.kind === 'live' ? device.activity.by?.name : undefined

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
    <Card className="w-full space-y-4 p-4 text-sm lg:w-96">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{en.control.title}</h2>
        {mine ? (
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={release.isPending}
            onClick={() => release.mutate()}
          >
            {en.control.release}
          </button>
        ) : (
          canWrite && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={take.isPending || device.activity.kind !== 'idle'}
              onClick={() => take.mutate()}
            >
              {en.control.take}
            </button>
          )
        )}
      </div>

      {mine ? (
        <p className="text-emerald-700">
          {en.control.youControl}
          {releaseAt !== undefined && (
            <span className="block text-xs text-slate-500" data-testid="auto-release">
              {en.control.autoRelease(clock(Math.min(releaseAt - now, mine.idle_timeout_ms)))}
            </span>
          )}
        </p>
      ) : holder ? (
        <p className="text-amber-800">{en.control.controlledBy(holder)}</p>
      ) : device.activity.kind === 'run' ? (
        <p className="text-slate-600">{en.control.busyRun}</p>
      ) : (
        !canWrite && <p className="text-slate-500">{en.control.viewOnly}</p>
      )}

      {notice && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
          {notice}
        </p>
      )}

      {mine && (
        <>
          <p className="text-xs text-slate-500">{en.control.hint}</p>
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
      )}
    </Card>
  )
}
