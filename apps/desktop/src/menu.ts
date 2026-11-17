import type { BaseWindow, KeyboardInputEvent, MenuItemConstructorOptions } from 'electron'

export type HistoryStep = 'undo' | 'redo'

/** What a history item acts on: the page's web contents. */
export interface HistoryTarget {
  undo(): void
  redo(): void
  sendInputEvent(event: KeyboardInputEvent): void
}

/** The key the app itself undoes and redoes by (`historyKey` in apps/web): ⌘Z, ⇧⌘Z; Ctrl+Z, Ctrl+Y. */
export function historyKeys(step: HistoryStep, platform: NodeJS.Platform) {
  const mac = platform === 'darwin'
  if (step === 'undo') return { keyCode: 'Z', modifiers: [mac ? 'meta' : 'control'] }
  return mac
    ? { keyCode: 'Z', modifiers: ['shift', 'meta'] }
    : { keyCode: 'Y', modifiers: ['control'] }
}

/**
 * Edit → Undo and Redo. The app has its own undo (the board's, a note's, a book's), on the same
 * keys. A key reaches the page first; only one the page left alone comes back to the menu as its
 * accelerator (`byAccelerator`): a plain text field's, whose undo is the field's own (`undo()`).
 * A click on the menu item presses the key in the page, so the app's own undo hears it.
 */
export function runHistory(
  step: HistoryStep,
  target: HistoryTarget,
  byAccelerator: boolean,
  platform: NodeJS.Platform,
): void {
  if (byAccelerator) {
    if (step === 'undo') target.undo()
    else target.redo()
    return
  }
  const { keyCode, modifiers } = historyKeys(step, platform)
  const mods = modifiers as KeyboardInputEvent['modifiers']
  target.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
  target.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
}

export interface MenuOptions {
  platform: NodeJS.Platform
  /** Development (not packaged): reload and the developer tools. */
  dev: boolean
  name: string
  history(step: HistoryStep, byAccelerator: boolean, window: BaseWindow | undefined): void
  showDataFolder(): void
  /** Windows and Linux: Help → About (macOS has it in the app menu). */
  about(): void
  /** Beside About: ask GitHub now whether a newer Papertie exists. */
  checkForUpdates(): void
}

/**
 * The native menu. Its accelerators keep clear of the app's own shortcuts (⌘K search, ⌘F a book's
 * find, ⌘D duplicate, ⌘B and ⌘I in a book, ⌘1 and ⌘2), and every key reaches the page before the
 * menu, so the app's ⌘Z stays the app's (`runHistory`). Copy, paste and the rest are the standard
 * roles, so text fields have them.
 */
export function menuTemplate(o: MenuOptions): MenuItemConstructorOptions[] {
  const mac = o.platform === 'darwin'
  const step =
    (s: HistoryStep): MenuItemConstructorOptions['click'] =>
    (_item, window, event) =>
      o.history(s, event?.triggeredByAccelerator === true, window)

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { id: 'undo', label: 'Undo', accelerator: 'CommandOrControl+Z', click: step('undo') },
      {
        id: 'redo',
        label: 'Redo',
        accelerator: mac ? 'Shift+Command+Z' : 'Control+Y',
        click: step('redo'),
      },
      { type: 'separator' },
      { role: 'cut', accelerator: 'CommandOrControl+X' },
      { role: 'copy', accelerator: 'CommandOrControl+C' },
      { role: 'paste', accelerator: 'CommandOrControl+V' },
      { role: 'selectAll', accelerator: 'CommandOrControl+A' },
    ],
  }

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      ...(o.dev
        ? ([
            { role: 'reload', accelerator: 'CommandOrControl+R' },
            { role: 'forceReload', accelerator: 'Shift+CommandOrControl+R' },
            {
              role: 'toggleDevTools',
              accelerator: mac ? 'Alt+Command+I' : 'Control+Shift+I',
            },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom', accelerator: 'CommandOrControl+0' },
      { role: 'zoomIn', accelerator: 'CommandOrControl+Plus' },
      // ⌘= too, unshifted, as browsers take it; hidden beside the item that shows ⌘+.
      {
        role: 'zoomIn',
        accelerator: 'CommandOrControl+=',
        visible: false,
        acceleratorWorksWhenHidden: true,
      },
      { role: 'zoomOut', accelerator: 'CommandOrControl+-' },
      { type: 'separator' },
      { role: 'togglefullscreen', accelerator: mac ? 'Control+Command+F' : 'F11' },
    ],
  }

  const updates: MenuItemConstructorOptions = {
    id: 'check-updates',
    label: 'Check for Updates…',
    click: () => o.checkForUpdates(),
  }

  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { id: 'data-folder', label: 'Show Data Folder', click: () => o.showDataFolder() },
      ...(mac
        ? []
        : ([
            { type: 'separator' },
            updates,
            { id: 'about', label: `About ${o.name}`, click: () => o.about() },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  }

  if (!mac) {
    return [
      { label: 'File', submenu: [{ role: 'quit', label: 'Quit', accelerator: 'Control+Q' }] },
      edit,
      view,
      help,
    ]
  }
  return [
    {
      label: o.name,
      submenu: [
        { role: 'about', label: `About ${o.name}` },
        updates,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${o.name}`, accelerator: 'Command+H' },
        { role: 'hideOthers', accelerator: 'Alt+Command+H' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${o.name}`, accelerator: 'Command+Q' },
      ],
    },
    { label: 'File', submenu: [{ role: 'close', accelerator: 'Command+W' }] },
    edit,
    view,
    {
      role: 'window',
      submenu: [
        { role: 'minimize', accelerator: 'Command+M' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    help,
  ]
}
