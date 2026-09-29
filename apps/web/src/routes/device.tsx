import type { api } from '@coral/shared'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useControl } from '../api/control'
import { useCoral, useDevices, useRole } from '../api/queries'
import { ActivityBadge } from '../components/activity'
import { ControlPanel } from '../components/ControlPanel'
import { PageHeader } from '../components/Layout'
import { LiveView, type FrameInfo } from '../components/LiveView'
import { Card, QueryState } from '../components/ui'
import { en } from '../i18n/en'

/** `/devices/$deviceId`: the live screen of one device (US2), and controlling it (US3). */
export function DevicePage() {
  const { deviceId } = useParams({ from: '/_app/devices/$deviceId' })
  const devices = useDevices()
  const device = devices.data?.find((d) => d.id === deviceId)

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link to="/devices" className="hover:text-slate-800">
          {en.device.back}
        </Link>
      </nav>
      <QueryState
        query={{ ...devices, data: devices.data ? [device] : undefined }}
        isEmpty={([d]) => d === undefined}
        empty={en.device.notFound}
      >
        {() => device && <Device device={device} />}
      </QueryState>
    </section>
  )
}

function Device({ device }: { device: api.DeviceView }) {
  const { session } = useCoral()
  const me = useSyncExternalStore(session.subscribe, session.getSnapshot).session?.user.id
  const { canWrite } = useRole()
  const control = useControl(device.id, me)
  const [frame, setFrame] = useState<FrameInfo | undefined>()
  const { refresh } = control
  // Someone took or let go of the device (devices.updated): read the control session again.
  const holderId = device.activity.kind === 'live' ? device.activity.by?.user_id : undefined
  useEffect(() => {
    void refresh()
  }, [refresh, device.activity.kind, holderId])

  return (
    <>
      <PageHeader title={device.model}>
        <ActivityBadge activity={device.activity} />
      </PageHeader>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <LiveView
          deviceId={device.id}
          onFrameInfo={setFrame}
          {...(control.mine ? { onGesture: (command) => void control.send(command) } : {})}
        />
        <div className="flex w-full flex-col gap-4 lg:w-96">
          <ControlPanel device={device} control={control} canWrite={canWrite} />
          <Card className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
            <span className="text-slate-500">{en.device.serial}</span>
            <span className="font-mono">{device.udid}</span>
            <span className="text-slate-500">{en.device.os}</span>
            <span>
              Android {device.os_version}
              {device.api_level !== null && ` · API ${device.api_level}`}
            </span>
            <span className="text-slate-500">{en.device.kind}</span>
            <span>{device.kind}</span>
            <span className="text-slate-500">{en.device.screen}</span>
            <span data-testid="device-screen">
              {frame ? `${frame.deviceWidth} × ${frame.deviceHeight}` : '—'}
            </span>
          </Card>
        </div>
      </div>
    </>
  )
}
