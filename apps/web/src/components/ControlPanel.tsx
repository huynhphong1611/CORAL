import type { api } from '@coral/shared'
import type { useControl } from '../api/control'
import { en } from '../i18n/en'
import { DeviceActions } from './DeviceActions'
import { buttonClass, Card, useNow } from './ui'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/**
 * Take / release a device and, while holding it, the buttons and typing of FR-008 (US3). Viewers
 * only see who controls the device.
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
  const holder = device.activity.kind === 'live' ? device.activity.by?.name : undefined

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
          <DeviceActions send={send} />
        </>
      )}
    </Card>
  )
}
