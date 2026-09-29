import { useDevices } from '../api/queries'
import { ActivityBadge } from '../components/activity'
import { PageHeader } from '../components/Layout'
import { QueryState, Table, Td, Th } from '../components/ui'
import { en } from '../i18n/en'

/** `/devices`: every device of the tenant and what it is doing, live (FR-003, T023). */
export function DevicesPage() {
  const devices = useDevices()
  return (
    <section>
      <PageHeader title={en.devices.title} />
      <QueryState query={devices} empty={en.devices.empty}>
        {(list) => (
          <Table label={en.devices.title}>
            <thead>
              <tr>
                <Th>{en.devices.model}</Th>
                <Th>{en.devices.os}</Th>
                <Th>{en.devices.kind}</Th>
                <Th>{en.devices.udid}</Th>
                <Th>{en.devices.activity}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((device) => (
                <tr key={device.id} data-device-id={device.id} className="hover:bg-slate-50">
                  <Td className="font-medium text-slate-900">{device.model}</Td>
                  <Td className="text-slate-600">
                    Android {device.os_version}
                    {device.api_level !== null && (
                      <span className="text-slate-400"> · API {device.api_level}</span>
                    )}
                  </Td>
                  <Td className="text-slate-600">{device.kind}</Td>
                  <Td className="font-mono text-xs text-slate-500">{device.udid}</Td>
                  <Td>
                    <ActivityBadge activity={device.activity} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </section>
  )
}
