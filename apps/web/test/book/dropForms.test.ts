// @vitest-environment jsdom
import { chosen, DROP_FORMS_KEY, likelyForm } from '../../src/book/drop/dropForms'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the drop form chosen most', () => {
  it('likelyForm follows the form chosen most and ignores unusable storage', () => {
    // None chosen yet: Paragraph.
    expect(likelyForm()).toBe('p')
    chosen('quote')
    expect(likelyForm()).toBe('quote')
    chosen('prompt')
    // A tie: Paragraph.
    expect(likelyForm()).toBe('p')
    chosen('prompt')
    expect(likelyForm()).toBe('prompt')
    chosen('p')
    chosen('p')
    chosen('p')
    expect(likelyForm()).toBe('p')
    expect(JSON.parse(localStorage.getItem(DROP_FORMS_KEY) ?? '{}')).toEqual({
      p: 3,
      quote: 1,
      prompt: 2,
    })
    // What is kept is not what the app wrote: nothing of it is trusted.
    for (const junk of ['not json', '[1,2]', '{"quote":"many","prompt":-4,"x":9}', 'null']) {
      localStorage.setItem(DROP_FORMS_KEY, junk)
      expect(likelyForm()).toBe('p')
    }
    localStorage.setItem(DROP_FORMS_KEY, '{"quote":2,"x":9}')
    expect(likelyForm()).toBe('quote')
    // Storage that throws (blocked, full): Paragraph, and choosing never throws.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(likelyForm()).toBe('p')
    expect(() => chosen('quote')).not.toThrow()
  })
})
