import { expect, it } from 'vitest'
import { previewAt, type ConnectionPreview, type PreviewOffer } from './connectionPreview'

const DOC: ConnectionPreview = { gatekeeperId: 7, title: 'Plan', url: 'https://docs.example/plan' }
const FILE: ConnectionPreview = {
  gatekeeperId: 8, item: 'docs:folder/file', title: 'Budget', connectionTitle: 'Finance',
}
const focus = (gadgetId: number, anchor?: string) => ({
  gadgetId, gadgetTitle: 'Finance', ...anchor !== undefined && { spot: { anchor, label: 'Costs' } },
})
// What the connection offers of itself: a preview of its own, none, or no answer.
const offers = (offer?: PreviewOffer) => async () => offer
const gone = async () => { throw new Error('gone') }

it('opens the preview with changes waiting that a focus was on', async () => {
  const pending = [DOC, FILE, { ...FILE, item: 'docs:other' }]
  expect(await previewAt(focus(7), pending, gone)).toBe(DOC)
  expect(await previewAt(focus(7, '?tab=t.1#heading=h.costs'), pending, gone)).toBe(DOC)
  expect(await previewAt(focus(8, 'docs:folder/file'), pending, gone)).toBe(FILE)
  expect(await previewAt(focus(8, 'docs:folder/file ?tab=t.1'), pending, gone)).toBe(FILE)
})

it('tells a preview with none from what its connection offers', async () => {
  // A connection with a preview of its own is drawn whole, wherever the spot is.
  expect(await previewAt(focus(7, '?tab=t.1'), [], offers({ url: DOC.url }))).toEqual(
    { gatekeeperId: 7, title: 'Finance', url: DOC.url })
  // One with none draws the item its anchor starts with, under the only title the message kept.
  expect(await previewAt(focus(8, 'docs:folder/file ?tab=t.1'), [{ ...FILE, item: 'docs:other' }], offers()))
    .toEqual({ gatekeeperId: 8, item: 'docs:folder/file', title: 'Finance' })
  expect(await previewAt(focus(8), [FILE], offers())).toBeUndefined()
  await expect(previewAt(focus(8, 'docs:folder/file'), [], gone)).rejects.toThrow('gone')
})
