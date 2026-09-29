import { Link, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { useDevices } from '../api/queries'
import { ActivityBadge } from '../components/activity'
import { PageHeader } from '../components/Layout'
import { LiveView, type FrameInfo } from '../components/LiveView'
import { Card, QueryState } from '../components/ui'
import { en } from '../i18n/en'

/** `/devices/$deviceId`: the live screen of one device (US2) and what it is doing. */
export function DevicePage() {
  const { deviceId } = useParams({ from: '/_app/devices/$deviceId' })
  const devices = useDevices()
  const device = devices.data?.find((d) => d.id === deviceId)
  const [frame, setFrame] = useState<FrameInfo | undefined>()

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
        {() =>
          device && (
            <>
              <PageHeader title={device.model}>
                <ActivityBadge activity={device.activity} />
              </PageHeader>
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                <LiveView deviceId={device.id} onFrameInfo={setFrame} />
                <Card className="grid min-w-64 grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
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
            </>
          )
        }
      </QueryState>
    </section>
  )
}
