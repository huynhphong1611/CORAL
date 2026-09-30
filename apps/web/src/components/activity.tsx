import type { api } from '@coral/shared'
import { Link } from '@tanstack/react-router'
import { en } from '../i18n/en'
import { Badge, shortId, type Tone } from './ui'

/** `idle`, `busy · run …`, `controlled by …`, `recording by …`, `offline` (contracts/web-ui.md). */
export function activityLabel(activity: api.DeviceActivity): string {
  switch (activity.kind) {
    case 'idle':
      return en.devices.idle
    case 'offline':
      return en.devices.offline
    case 'run':
      return activity.run_id
        ? `${en.devices.busyRun} ${shortId(activity.run_id)}`
        : en.devices.busyRun
    case 'live':
      return en.devices.controlledBy(activity.by?.name ?? '?')
    case 'recording':
      return en.devices.recordingBy(activity.by?.name ?? '?')
  }
}

const TONE: Record<api.DeviceActivity['kind'], Tone> = {
  idle: 'green',
  offline: 'slate',
  run: 'blue',
  live: 'amber',
  recording: 'violet',
}

/** The activity as a badge; a run links to its page. */
export function ActivityBadge({ activity }: { activity: api.DeviceActivity }) {
  if (activity.kind === 'run' && activity.run_id) {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="blue">
          {en.devices.busyRun}{' '}
          <Link
            to="/runs/$runId"
            params={{ runId: activity.run_id }}
            className="font-mono underline-offset-2 hover:underline"
          >
            {shortId(activity.run_id)}
          </Link>
        </Badge>
        {activity.by && (
          <span className="text-xs text-slate-500">{en.devices.by(activity.by.name)}</span>
        )}
      </span>
    )
  }
  return <Badge tone={TONE[activity.kind]}>{activityLabel(activity)}</Badge>
}
