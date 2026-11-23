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

it('shows a saved gatekeeper setting as saved, whatever reads of the settings do around the save', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const search = { vendorId: 'websearch', displayName: 'Web Search', autoProvisions: true,
    ambientMode: 'optional',
    settings: [{ id: 'provider', label: 'Search provider', help: 'Where searches go.',
      defaultValue: 'ceramic', value: 'ceramic' }],
  } satisfies AdminResourceVendor
  const repository = { resourceTypeId: 'repository', urlPattern: 'https://example.com/:repo',
    title: 'Repository', description: 'Read code', enabled: false }
  const example = { vendorId: 'example', displayName: 'Example', enabled: true,
    autoProvisions: false, resources: [repository],
  } satisfies AdminResourceVendor
  // The read a resource toggle makes: it begins before the provider is saved, and answers after
  // it with the provider it found. A read after that one would fail.
  const refresh = Promise.withResolvers<AdminSettingsView>()
  const getSettings = vi.fn<AdminApi['getSettings']>().mockResolvedValueOnce(viewOf([search, example]))
    .mockReturnValueOnce(refresh.promise).mockRejectedValue(new Error('Settings unavailable'))
  const setGatekeeperSetting = vi.fn<AdminApi['setGatekeeperSetting']>(async () => {})
  getAdminApi.mockResolvedValue({
    getSettings, setGatekeeperSetting, setResourceEnabled: async () => {}, getUpdateStatus: async () => null,
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const form = () => container.querySelector<HTMLInputElement>('input[placeholder="ceramic"]')!.form!
  const repositoryRow = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.querySelector('p')?.textContent === 'Repository')!
  const expectSaved = () => {
    expect(form().querySelector('input')!.value).toBe('exa')
    expect(form().querySelector('input')!.getAttribute('aria-invalid')).toBe('false')
    // Saved: there is nothing left to save.
    expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  }
  try {
    await act(async () => { root.render(<AdminPage />) })
    await act(async () => { repositoryRow().click() })
    const input = form().querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'exa')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await act(async () => { form().requestSubmit() })

    expect(setGatekeeperSetting).toHaveBeenCalledWith('websearch', 'provider', 'exa')
    expectSaved()

    await act(async () => {
      refresh.resolve(viewOf([search, { ...example, resources: [{ ...repository, enabled: true }] }]))
    })
    expectSaved()
    expect(repositoryRow().querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
  }
})
