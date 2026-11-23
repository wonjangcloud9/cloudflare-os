// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatekeeperSettingField } from './GatekeeperSettingField'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const SETTING = {
  id: 'provider', label: 'Search provider', help: 'Where searches go.', defaultValue: 'ceramic',
  value: 'ceramic',
}
const REFUSAL = 'The search provider must be one of: ceramic, linkup, exa.'

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

describe('GatekeeperSettingField', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (onSave: (value: string) => Promise<void>) => {
    await act(async () => root.render(<GatekeeperSettingField setting={SETTING} onSave={onSave} />))
  }

  const input = () => {
    const element = container.querySelector('input')
    if (!element) throw new Error('no input')
    return element
  }

  const saveButton = () => {
    const element = container.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (!element) throw new Error('no Save button')
    return element
  }

  const submit = () => act(async () => {
    container.querySelector('form')!.requestSubmit()
  })

  const said = () => container.querySelector('[role="alert"]')?.textContent

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps a refused value, with the gatekeeper\'s reason, until the admin edits it', async () => {
    await render(async () => { throw new Error(REFUSAL) })

    await type(input(), 'bing')
    await submit()

    expect(input().value).toBe('bing')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain(REFUSAL)
    // The field has focus, and an error on the field that has focus is said as an alert.
    expect(document.activeElement).toBe(input())
    expect(said()).toBe(REFUSAL)
    expect(saveButton().disabled).toBe(false)

    await type(input(), 'exa')
    expect(container.textContent).not.toContain(REFUSAL)
    expect(container.textContent).toContain(SETTING.help)
    expect(input().getAttribute('aria-invalid')).toBe('false')
    expect(said()).toBeUndefined()
  })

  it('saves what was typed without the spaces around it, and nothing when only spaces differ', async () => {
    const onSave = vi.fn<(value: string) => Promise<void>>(async () => {})
    await render(onSave)

    await type(input(), ' ceramic ')
    expect(saveButton().disabled).toBe(true)
    await submit()
    expect(onSave).not.toHaveBeenCalled()

    await type(input(), ' exa ')
    await submit()
    expect(onSave.mock.calls).toEqual([['exa']])
  })

  it('puts the value in effect back on Reset, and keeps focus in the field', async () => {
    await render(async () => {})
    await type(input(), 'exa')
    const reset = container.querySelector<HTMLButtonElement>('button[type="button"]')
    if (!reset) throw new Error('no Reset button')

    // Reset goes away with the edit it undoes, and focus must not go with it.
    await act(async () => {
      reset.focus()
      reset.click()
    })

    expect(input().value).toBe('ceramic')
    expect(container.querySelector('button[type="button"]')).toBeNull()
    expect(document.activeElement).toBe(input())
  })
})
