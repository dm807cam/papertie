import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OpenQueue, papertieFiles } from '../src/fileOpen'

describe('papertieFiles: the .papertie files on a command line', () => {
  it('takes the .papertie arguments, resolved against the working directory', () => {
    const cwd = resolve('/Users/mika/Desktop')
    expect(
      papertieFiles(['/Applications/Papertie.app/Contents/MacOS/Papertie', 'Garden.papertie'], cwd),
    ).toEqual([join(cwd, 'Garden.papertie')])
    expect(papertieFiles(['Papertie.exe', 'C:/Boards/Garden.PAPERTIE'], cwd)).toEqual([
      resolve(cwd, 'C:/Boards/Garden.PAPERTIE'),
    ])
  })

  it('leaves the executable, switches, the dev app path and other files alone', () => {
    const cwd = resolve('/tmp')
    expect(
      papertieFiles(
        [
          '/usr/bin/electron',
          '.',
          '--inspect=9229',
          '--user-data-dir=/x/a.papertie',
          'notes.jsonl',
          'photo.png',
          'Plain',
        ],
        cwd,
      ),
    ).toEqual([])
    // The executable itself never counts, whatever its name.
    expect(papertieFiles(['/opt/odd.papertie'], cwd)).toEqual([])
    expect(papertieFiles([], cwd)).toEqual([])
  })

  it('keeps several, in order, once each', () => {
    const cwd = resolve('/b')
    expect(papertieFiles(['app', 'one.papertie', 'two.papertie', 'one.papertie'], cwd)).toEqual([
      join(cwd, 'one.papertie'),
      join(cwd, 'two.papertie'),
    ])
  })
})

describe('OpenQueue: files opened before the page can take them wait for it', () => {
  it('holds files until a page attaches, then hands them over in order', () => {
    const q = new OpenQueue()
    q.open('/a.papertie')
    q.open('/b.papertie')
    const got: string[] = []
    q.attach((p) => got.push(p))
    expect(got).toEqual(['/a.papertie', '/b.papertie'])
    q.open('/c.papertie')
    expect(got).toEqual(['/a.papertie', '/b.papertie', '/c.papertie'])
  })

  it('a page that leaves (a reload) takes nothing until it attaches again', () => {
    const q = new OpenQueue()
    const first: string[] = []
    q.attach((p) => first.push(p))
    q.detach()
    q.open('/a.papertie')
    expect(first).toEqual([])
    const second: string[] = []
    q.attach((p) => second.push(p))
    expect(second).toEqual(['/a.papertie'])
  })
})
