import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { ChunkBoundary, lazyChunk } from '../../src/app/ChunkBoundary'

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

describe('lazy screens', () => {
  it('a chunk already in renders in the commit that mounts it; one not in shows nothing until it is', async () => {
    let arrive: (c: typeof Hello) => void = () => {}
    const chunk = lazyChunk(() => new Promise<typeof Hello>((r) => (arrive = r)))
    const view = render(
      <Suspense fallback={null}>
        <chunk.Component name="shelf" />
      </Suspense>,
    )
    expect(view.container.textContent).toBe('')
    await act(async () => arrive(Hello))
    expect(screen.getByText('Hello shelf')).toBeTruthy()
    view.unmount()
    // In now: no suspending, no blank commit.
    const again = render(
      <Suspense fallback={<p>fallback</p>}>
        <chunk.Component name="again" />
      </Suspense>,
    )
    expect(again.container.textContent).toBe('Hello again')
  })

  it('a chunk that fails shows the slip, and "Try again" loads it again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let online = false
    let tries = 0
    const chunk = lazyChunk(async () => {
      tries++
      if (!online) throw new Error('offline')
      return Hello
    })
    render(
      <ChunkBoundary>
        <Suspense fallback={null}>
          <chunk.Component name="book" />
        </Suspense>
      </ChunkBoundary>,
    )
    const slip = await screen.findByRole('alert')
    expect(slip.textContent).toContain('Couldn’t open this. Check your connection and try again.')
    // Counted in the console, never more.
    expect(errors.mock.calls.some((c) => String(c[0]).startsWith('chunk load failed ('))).toBe(true)
    // Nothing tries again by itself meanwhile: no loop of failing fetches.
    const failedTries = tries
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(tries).toBe(failedTries)
    online = true
    await act(async () => screen.getByRole('button', { name: 'Try again' }).click())
    expect(await screen.findByText('Hello book')).toBeTruthy()
    expect(tries).toBe(failedTries + 1)
    errors.mockRestore()
  })
})
