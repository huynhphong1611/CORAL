import { describe, expect, it } from 'vitest'
import { FAILURE_CODES, isFailureCode } from './failure-codes'
import { PERMISSIONS, androidPermissions, isPermission } from './permissions'

describe('failure codes (§8.5)', () => {
  it('lists the eight codes and recognises them', () => {
    expect(FAILURE_CODES).toHaveLength(8)
    expect(isFailureCode('BLOCKED_BY_POPUP')).toBe(true)
    expect(isFailureCode('OOPS')).toBe(false)
  })
})

describe('permissions (§7.5)', () => {
  it('recognises the vocabulary', () => {
    expect(isPermission('camera')).toBe(true)
    expect(isPermission('teleport')).toBe(false)
  })

  it('maps every permission on a recent Android', () => {
    for (const permission of PERMISSIONS) {
      expect(androidPermissions(permission, 34).length).toBeGreaterThan(0)
    }
  })

  it('handles API-level differences', () => {
    expect(androidPermissions('notifications', 32)).toEqual([])
    expect(androidPermissions('notifications', 33)).toEqual([
      'android.permission.POST_NOTIFICATIONS',
    ])
    expect(androidPermissions('photos', 30)).toEqual(['android.permission.READ_EXTERNAL_STORAGE'])
    expect(androidPermissions('location_always', 28)).not.toContain(
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    )
  })
})
