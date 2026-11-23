// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AdminApi, AdminResourceVendor, AdminSettingsView } from '@gadgets/workshop-shared/api'

const { getAdminApi, addToast } = vi.hoisted(() => ({
  getAdminApi: vi.fn<() => Promise<unknown>>(),
  addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
}))
const authenticatedApi = { getAdminApi }
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi, isAdmin: true }) }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn<() => void>(), useSearch: () => ({ tab: 'gatekeepers' }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))
vi.mock('./features/deployment-updates/probeRouterTag', () => ({ probeRouterTag: async () => null }))

import AdminPage from './AdminPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => vi.clearAllMocks())

// The admin view of a deployment whose gatekeepers are `resourceVendors`.
const viewOf = (resourceVendors: AdminResourceVendor[]): AdminSettingsView => ({
  signupsEnabled: true, userSearchEnabled: false, snapshotSharingEnabled: true, siteName: '',
  instanceInstructions: '',
  announcement: '', banner: { text: '', color: 'neutral' }, accentColor: '', formats: [],
  restrictedWebFetchHosts: [], restrictedWebFetchApprovals: false,
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'metadata' },
  adminAuditRetentionDays: { effective: 30, chosen: 30, min: 30 },
  resourceVendors,
})

it.each([
  { outcome: 'succeeds', refreshFails: false },
  { outcome: 'fails', refreshFails: true },
])('reports a saved resource toggle accurately when policy refresh $outcome', async ({ refreshFails }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const retired = 'https://example.com/retired/*'
  const current = [
    { resourceTypeId: 'repository', urlPattern: 'https://example.com/:repo', title: 'Repository',
      description: 'Read code', enabled: false },
    { resourceTypeId: 'issue', urlPattern: 'https://example.com/:repo/issues/:id', title: 'Issue',
      description: 'Read issues', enabled: false },
  ]
  const vendor = { vendorId: 'example', displayName: 'Example', enabled: true,
    autoProvisions: false, resources: [...current,
      { urlPattern: retired, title: 'Unavailable resource type', description: 'Old restriction', enabled: false }],
  } satisfies AdminResourceVendor
  const settings = viewOf([vendor])
  const getSettings = vi.fn<AdminApi['getSettings']>().mockResolvedValueOnce(settings).mockResolvedValue({ ...settings,
    resourceVendors: [{ ...vendor, resources: current.map(r => ({ ...r, enabled: true })) }],
  })
  if (refreshFails) getSettings.mockRejectedValueOnce(new Error('Settings unavailable'))
  const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>(async () => {})
  getAdminApi.mockResolvedValue({ getSettings, setResourceEnabled, getUpdateStatus: async () => null })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const row = (title: string) => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.querySelector('p')?.textContent === title)!
  try {
    await act(async () => { root.render(<AdminPage />) })
    expect(row('Repository').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { row('Unavailable resource type').click() })
    expect(setResourceEnabled).toHaveBeenCalledWith('example', retired, true)
    expect(row('Unavailable resource type') !== undefined).toBe(refreshFails)
    for (const title of ['Repository', 'Issue']) {
      expect(row(title).querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(String(!refreshFails))
    }
    expect(addToast.mock.calls).toEqual(refreshFails ? [[{
        title: 'Change saved, but resource settings could not be refreshed. Reload this page.',
        variant: 'error',
    }]] : [])
    expect(getSettings).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('shows a saved gatekeeper setting as saved, whatever a later read of the settings would do', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const vendor = { vendorId: 'websearch', displayName: 'Web Search', autoProvisions: true,
    ambientMode: 'optional',
    settings: [{ id: 'provider', label: 'Search provider', help: 'Where searches go.',
      defaultValue: 'ceramic', value: 'ceramic' }],
  } satisfies AdminResourceVendor
  // A read after the first one would fail, or put back the values the first one held.
  const getSettings = vi.fn<AdminApi['getSettings']>().mockResolvedValueOnce(viewOf([vendor]))
    .mockRejectedValue(new Error('Settings unavailable'))
  const setGatekeeperSetting = vi.fn<AdminApi['setGatekeeperSetting']>(async () => {})
  getAdminApi.mockResolvedValue({ getSettings, setGatekeeperSetting, getUpdateStatus: async () => null })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const form = () => container.querySelector<HTMLInputElement>('input[placeholder="ceramic"]')!.form!
  try {
    await act(async () => { root.render(<AdminPage />) })
    const input = form().querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'exa')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await act(async () => { form().requestSubmit() })

    expect(setGatekeeperSetting).toHaveBeenCalledWith('websearch', 'provider', 'exa')
    expect(form().querySelector('input')!.value).toBe('exa')
    expect(form().querySelector('input')!.getAttribute('aria-invalid')).toBe('false')
    // Saved: there is nothing left to save.
    expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
  }
})
