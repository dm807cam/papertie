import type { KeyboardInputEvent, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { type MenuOptions, menuTemplate, runHistory } from '../src/menu'

const options = (platform: NodeJS.Platform, dev = false): MenuOptions => ({
  platform,
  dev,
  name: 'Papertie',
  history: vi.fn(),
  showDataFolder: vi.fn(),
  about: vi.fn(),
  checkForUpdates: vi.fn(),
})

/** Every item, submenus included. */
function items(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return menu.flatMap((m) => [
    m,
    ...(Array.isArray(m.submenu) ? items(m.submenu as MenuItemConstructorOptions[]) : []),
  ])
}

/** An accelerator as the keys it is on this platform: `Cmd+K`, `Ctrl+Shift+Z`. */
function keysOf(accelerator: string, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin'
  const parts = accelerator.split('+').map((p) => {
    if (/^(CommandOrControl|CmdOrCtrl)$/i.test(p)) return mac ? 'Cmd' : 'Ctrl'
    if (/^(Command|Cmd)$/i.test(p)) return 'Cmd'
    if (/^(Control|Ctrl)$/i.test(p)) return 'Ctrl'
    if (/^(Alt|Option)$/i.test(p)) return 'Alt'
    return p.length === 1 ? p.toUpperCase() : p
  })
  const key = parts.pop() as string
  return [...parts.sort(), key].join('+')
}

/** The app's own shortcuts (apps/web): a menu accelerator on any of them would take it. */
const APP_KEYS = (platform: NodeJS.Platform) => {
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl'
  return ['K', 'F', 'D', 'B', 'I', '1', '2', 'Enter'].map((k) => `${mod}+${k}`)
}

describe('the native menu', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`${platform}: no accelerator takes one of the app's shortcuts`, () => {
      for (const dev of [false, true]) {
        const accelerators = items(menuTemplate(options(platform, dev)))
          .map((i) => i.accelerator)
          .filter((a): a is string => typeof a === 'string')
          .map((a) => keysOf(a, platform))
        expect(accelerators.length).toBeGreaterThan(5)
        for (const key of APP_KEYS(platform)) expect(accelerators).not.toContain(key)
        // Each accelerator once.
        expect(new Set(accelerators).size).toBe(accelerators.length)
      }
    })

    it(`${platform}: Edit has undo and redo of the app's own, and the standard editing roles`, () => {
      const edit = menuTemplate(options(platform)).find((m) => m.label === 'Edit')
      const sub = (edit?.submenu ?? []) as MenuItemConstructorOptions[]
      const undo = sub.find((i) => i.id === 'undo')
      const redo = sub.find((i) => i.id === 'redo')
      // Not the native roles: those would never reach the app's own undo.
      expect(undo?.role).toBeUndefined()
      expect(redo?.role).toBeUndefined()
      expect(keysOf(undo?.accelerator as string, platform)).toBe(
        platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z',
      )
      expect(keysOf(redo?.accelerator as string, platform)).toBe(
        platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y',
      )
      expect(sub.map((i) => i.role).filter(Boolean)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    })

    it(`${platform}: reload and the developer tools only in development`, () => {
      const roles = (dev: boolean) => items(menuTemplate(options(platform, dev))).map((i) => i.role)
      expect(roles(false)).not.toContain('reload')
      expect(roles(false)).not.toContain('toggleDevTools')
      expect(roles(true)).toContain('reload')
      expect(roles(true)).toContain('toggleDevTools')
      expect(roles(false)).toEqual(expect.arrayContaining(['resetZoom', 'zoomIn', 'zoomOut']))
    })
  }

  it('macOS: the app menu (About, Hide, Quit), Edit, View, Window and Help', () => {
    const menu = menuTemplate(options('darwin'))
    expect(menu.map((m) => m.label ?? m.role)).toEqual([
      'Papertie',
      'File',
      'Edit',
      'View',
      'window',
      'help',
    ])
    const app = items([menu[0] as MenuItemConstructorOptions]).map((i) => i.role)
    expect(app).toEqual(expect.arrayContaining(['about', 'hide', 'quit']))
  })

  it('Windows and Linux: About is in Help', () => {
    const o = options('win32')
    const about = items(menuTemplate(o)).find((i) => i.id === 'about')
    about?.click?.({} as never, undefined, {} as never)
    expect(o.about).toHaveBeenCalled()
  })

  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`${platform}: Check for Updates… is beside About, and asks`, () => {
      const o = options(platform)
      const menu = menuTemplate(o)
      const home = platform === 'darwin' ? menu[0] : menu.find((m) => m.role === 'help')
      const sub = (home?.submenu ?? []) as MenuItemConstructorOptions[]
      const at = sub.findIndex((i) => i.id === 'check-updates')
      expect(sub[at]?.label).toBe('Check for Updates…')
      expect(sub[at]?.accelerator).toBeUndefined()
      const about = sub.findIndex((i) => i.role === 'about' || i.id === 'about')
      expect(Math.abs(at - about)).toBe(1)
      expect(items(menu).filter((i) => i.id === 'check-updates')).toHaveLength(1)
      sub[at]?.click?.({} as never, undefined, {} as never)
      expect(o.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  }

  it('a history item says whether its accelerator or a click chose it', () => {
    const o = options('darwin')
    const edit = items(menuTemplate(o))
    edit
      .find((i) => i.id === 'undo')
      ?.click?.({} as never, undefined, { triggeredByAccelerator: true })
    edit.find((i) => i.id === 'redo')?.click?.({} as never, undefined, {} as never)
    expect(o.history).toHaveBeenNthCalledWith(1, 'undo', true, undefined)
    expect(o.history).toHaveBeenNthCalledWith(2, 'redo', false, undefined)
  })
})

describe('runHistory', () => {
  const target = () => {
    const sent: KeyboardInputEvent[] = []
    return {
      sent,
      undo: vi.fn(),
      redo: vi.fn(),
      sendInputEvent: (e: KeyboardInputEvent) => {
        sent.push(e)
      },
    }
  }

  it('a click presses the key in the page, so the app undoes', () => {
    const t = target()
    runHistory('undo', t, false, 'darwin')
    expect(t.sent).toEqual([
      { type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] },
    ])
    const w = target()
    runHistory('redo', w, false, 'win32')
    expect(w.sent[0]).toEqual({ type: 'keyDown', keyCode: 'Y', modifiers: ['control'] })
    const m = target()
    runHistory('redo', m, false, 'darwin')
    expect(m.sent[0]).toEqual({ type: 'keyDown', keyCode: 'Z', modifiers: ['shift', 'meta'] })
    expect(t.undo).not.toHaveBeenCalled()
  })

  it('a key the page left alone is the text field’s own undo, never pressed again', () => {
    const t = target()
    runHistory('undo', t, true, 'darwin')
    runHistory('redo', t, true, 'darwin')
    expect(t.undo).toHaveBeenCalledTimes(1)
    expect(t.redo).toHaveBeenCalledTimes(1)
    expect(t.sent).toEqual([])
  })
})
