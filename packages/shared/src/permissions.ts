/** Platform-neutral permission names allowed in `grant_permissions` (SPEC §7.5). */
export const PERMISSIONS = [
  'camera',
  'microphone',
  'location',
  'location_always',
  'notifications',
  'contacts',
  'photos',
  'calendar',
  'bluetooth',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

const P = 'android.permission.'

/**
 * Android runtime permissions to grant with `pm grant` for one abstract permission.
 * Returns [] when the permission does not exist (or is not runtime) on that API level.
 */
export function androidPermissions(permission: Permission, apiLevel: number): string[] {
  switch (permission) {
    case 'camera':
      return [`${P}CAMERA`]
    case 'microphone':
      return [`${P}RECORD_AUDIO`]
    case 'location':
      return [`${P}ACCESS_FINE_LOCATION`, `${P}ACCESS_COARSE_LOCATION`]
    case 'location_always':
      return [
        `${P}ACCESS_FINE_LOCATION`,
        `${P}ACCESS_COARSE_LOCATION`,
        ...(apiLevel >= 29 ? [`${P}ACCESS_BACKGROUND_LOCATION`] : []),
      ]
    case 'notifications':
      return apiLevel >= 33 ? [`${P}POST_NOTIFICATIONS`] : []
    case 'contacts':
      return [`${P}READ_CONTACTS`, `${P}WRITE_CONTACTS`]
    case 'photos':
      return apiLevel >= 33
        ? [`${P}READ_MEDIA_IMAGES`, `${P}READ_MEDIA_VIDEO`]
        : [`${P}READ_EXTERNAL_STORAGE`]
    case 'calendar':
      return [`${P}READ_CALENDAR`, `${P}WRITE_CALENDAR`]
    case 'bluetooth':
      return apiLevel >= 31 ? [`${P}BLUETOOTH_CONNECT`, `${P}BLUETOOTH_SCAN`] : []
  }
}
