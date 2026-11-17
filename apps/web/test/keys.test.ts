import {
  connectKey,
  historyKey,
  isTypingTarget,
  KEY_ZOOM_STEP,
  keyCommand,
  noteKey,
  toolKey,
} from '../src/interactions/keys'

const key = (k: string, code: string, extra: Partial<Parameters<typeof keyCommand>[0]> = {}) => ({
  key: k,
  code,
  shiftKey: false,
  target: null,
  ...extra,
})
const el = (o: { tagName: string; type?: string; isContentEditable?: boolean }) =>
  o as unknown as EventTarget

const TEXT_TYPES = ['text', 'search', 'url', 'email', 'number', 'password', 'tel']
const CONTROL_TYPES = ['checkbox', 'radio', 'range', 'button', 'submit', 'reset']

describe('isTypingTarget', () => {
  it('is true for text-like inputs, textareas and contenteditable only', () => {
    for (const type of TEXT_TYPES) expect(isTypingTarget(el({ tagName: 'INPUT', type }))).toBe(true)
    expect(isTypingTarget(el({ tagName: 'INPUT', type: 'EMAIL' }))).toBe(true)
    // No type attribute is a text field.
    expect(isTypingTarget(el({ tagName: 'INPUT' }))).toBe(true)
    expect(isTypingTarget(el({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(isTypingTarget(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
    for (const type of CONTROL_TYPES) {
      expect(isTypingTarget(el({ tagName: 'INPUT', type }))).toBe(false)
    }
    for (const tagName of ['BUTTON', 'SELECT', 'DIV', 'BODY']) {
      expect(isTypingTarget(el({ tagName }))).toBe(false)
    }
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('keyCommand', () => {
  it('maps =, -, Shift+Digit1, Shift+Digit2 and Space; ignores typing targets', () => {
    expect(KEY_ZOOM_STEP).toBe(1.25)
    expect(keyCommand(key('=', 'Equal'))).toBe('zoomIn')
    expect(keyCommand(key('+', 'Equal', { shiftKey: true }))).toBe('zoomIn')
    expect(keyCommand(key('+', 'NumpadAdd'))).toBe('zoomIn')
    expect(keyCommand(key('-', 'Minus'))).toBe('zoomOut')
    expect(keyCommand(key('-', 'NumpadSubtract'))).toBe('zoomOut')
    expect(keyCommand(key('!', 'Digit1', { shiftKey: true }))).toBe('fitAll')
    expect(keyCommand(key('@', 'Digit2', { shiftKey: true }))).toBe('fitSelection')
    expect(keyCommand(key('"', 'Digit2', { shiftKey: true }))).toBe('fitSelection')
    expect(keyCommand(key(' ', 'Space'))).toBe('panHold')

    expect(keyCommand(key('1', 'Digit1'))).toBeNull()
    expect(keyCommand(key('a', 'KeyA'))).toBeNull()

    for (const target of [
      el({ tagName: 'INPUT' }),
      el({ tagName: 'TEXTAREA' }),
      el({ tagName: 'DIV', isContentEditable: true }),
    ]) {
      expect(keyCommand(key('=', 'Equal', { target }))).toBeNull()
      expect(keyCommand(key(' ', 'Space', { target }))).toBeNull()
      expect(keyCommand(key('!', 'Digit1', { shiftKey: true, target }))).toBeNull()
    }
    expect(keyCommand(key('=', 'Equal', { target: el({ tagName: 'BUTTON' }) }))).toBe('zoomIn')
  })

  it('Space belongs to a focused select or button; zoom and fit keys still work there', () => {
    for (const tagName of ['SELECT', 'BUTTON']) {
      const target = el({ tagName })
      expect(keyCommand(key(' ', 'Space', { target }))).toBeNull()
      expect(keyCommand(key('=', 'Equal', { target }))).toBe('zoomIn')
      expect(keyCommand(key('-', 'Minus', { target }))).toBe('zoomOut')
      expect(keyCommand(key('!', 'Digit1', { shiftKey: true, target }))).toBe('fitAll')
    }
    // The canvas (no focus, or a note or the root) keeps Space.
    for (const target of [null, el({ tagName: 'BODY' }), el({ tagName: 'DIV' })]) {
      expect(keyCommand(key(' ', 'Space', { target }))).toBe('panHold')
    }
  })

  it('a focused checkbox, radio, range or button input acts like a button', () => {
    for (const type of CONTROL_TYPES) {
      const target = el({ tagName: 'INPUT', type })
      expect(keyCommand(key('=', 'Equal', { target }))).toBe('zoomIn')
      expect(keyCommand(key('-', 'Minus', { target }))).toBe('zoomOut')
      expect(keyCommand(key('!', 'Digit1', { shiftKey: true, target }))).toBe('fitAll')
      expect(keyCommand(key(' ', 'Space', { target }))).toBeNull()
      for (const k of ['v', 'y']) {
        expect(toolKey(key(k, `Key${k.toUpperCase()}`, { target }))).not.toBeNull()
      }
    }
    for (const type of TEXT_TYPES) {
      const target = el({ tagName: 'INPUT', type })
      expect(keyCommand(key('=', 'Equal', { target }))).toBeNull()
      expect(toolKey(key('v', 'KeyV', { target }))).toBeNull()
    }
  })

  it('leaves browser shortcuts alone (ctrl, meta, alt)', () => {
    expect(keyCommand(key('=', 'Equal', { metaKey: true }))).toBeNull()
    expect(keyCommand(key('-', 'Minus', { ctrlKey: true }))).toBeNull()
    expect(keyCommand(key(' ', 'Space', { altKey: true }))).toBeNull()
  })
})

describe('toolKey', () => {
  it('maps V and Y to the tools, outside typing targets and without modifiers', () => {
    expect(toolKey(key('v', 'KeyV'))).toBe('select')
    expect(toolKey(key('Y', 'KeyY', { shiftKey: true }))).toBe('yarn')
    expect(toolKey(key('y', 'KeyY'))).toBe('yarn')
    expect(toolKey(key('x', 'KeyX'))).toBeNull()
    expect(toolKey(key('v', 'KeyV', { metaKey: true }))).toBeNull()
    expect(toolKey(key('v', 'KeyV', { target: el({ tagName: 'INPUT' }) }))).toBeNull()
  })

  it('the withdrawn tools have no keys: H, N, T and M do nothing', () => {
    for (const k of ['h', 'H', 'n', 't', 'm']) {
      expect(toolKey(key(k, `Key${k.toUpperCase()}`))).toBeNull()
    }
  })

  it('a focused select keeps its type-ahead letters; a focused button passes them on', () => {
    for (const k of ['v', 'y']) {
      expect(
        toolKey(key(k, `Key${k.toUpperCase()}`, { target: el({ tagName: 'SELECT' }) })),
      ).toBeNull()
    }
    expect(toolKey(key('y', 'KeyY', { target: el({ tagName: 'BUTTON' }) }))).toBe('yarn')
    expect(toolKey(key('y', 'KeyY', { target: el({ tagName: 'BODY' }) }))).toBe('yarn')
  })
})

describe('historyKey', () => {
  it('⌘Z and Ctrl+Z undo; ⇧⌘Z, Ctrl+Y and Ctrl+Shift+Z redo', () => {
    expect(historyKey(key('z', 'KeyZ', { metaKey: true }))).toBe('undo')
    expect(historyKey(key('z', 'KeyZ', { ctrlKey: true }))).toBe('undo')
    expect(historyKey(key('Z', 'KeyZ', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(historyKey(key('z', 'KeyZ', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(historyKey(key('y', 'KeyY', { ctrlKey: true }))).toBe('redo')
    expect(historyKey(key('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('redo')
    // AZERTY's Z sits on KeyW: the letter decides. A non-Latin layout falls back to the key's place.
    expect(historyKey(key('z', 'KeyW', { metaKey: true }))).toBe('undo')
    expect(historyKey(key('я', 'KeyZ', { ctrlKey: true }))).toBe('undo')
  })

  it('is null without the chord, with other modifiers, and in typing targets', () => {
    expect(historyKey(key('z', 'KeyZ'))).toBeNull()
    expect(historyKey(key('z', 'KeyZ', { shiftKey: true }))).toBeNull()
    expect(historyKey(key('z', 'KeyZ', { metaKey: true, altKey: true }))).toBeNull()
    expect(historyKey(key('z', 'KeyZ', { metaKey: true, ctrlKey: true }))).toBeNull()
    expect(historyKey(key('y', 'KeyY', { metaKey: true }))).toBeNull()
    expect(historyKey(key('Y', 'KeyY', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(historyKey(key('x', 'KeyX', { metaKey: true }))).toBeNull()
    // The editor's textarea keeps its own undo.
    for (const target of [
      el({ tagName: 'TEXTAREA' }),
      el({ tagName: 'INPUT' }),
      el({ tagName: 'DIV', isContentEditable: true }),
    ]) {
      expect(historyKey(key('z', 'KeyZ', { metaKey: true, target }))).toBeNull()
      expect(historyKey(key('y', 'KeyY', { ctrlKey: true, target }))).toBeNull()
    }
    // A focused button (the sidebar) still undoes on the board.
    expect(historyKey(key('z', 'KeyZ', { metaKey: true, target: el({ tagName: 'BUTTON' }) }))).toBe(
      'undo',
    )
  })
})

describe('noteKey', () => {
  it('Enter edits, Delete and Backspace delete, ⌘D and Ctrl+D duplicate', () => {
    expect(noteKey(key('Enter', 'Enter'))).toBe('edit')
    expect(noteKey(key('Enter', 'Enter', { target: el({ tagName: 'ARTICLE' }) }))).toBe('edit')
    expect(noteKey(key('Delete', 'Delete'))).toBe('delete')
    expect(noteKey(key('Backspace', 'Backspace'))).toBe('delete')
    expect(noteKey(key('d', 'KeyD', { metaKey: true }))).toBe('duplicate')
    expect(noteKey(key('d', 'KeyD', { ctrlKey: true }))).toBe('duplicate')
    expect(noteKey(key('в', 'KeyD', { metaKey: true }))).toBe('duplicate')
  })

  it('is null in typing targets, with other chords, and for Enter on a control', () => {
    for (const target of [el({ tagName: 'TEXTAREA' }), el({ tagName: 'INPUT' })]) {
      expect(noteKey(key('Enter', 'Enter', { target }))).toBeNull()
      expect(noteKey(key('Backspace', 'Backspace', { target }))).toBeNull()
      expect(noteKey(key('d', 'KeyD', { metaKey: true, target }))).toBeNull()
    }
    for (const tagName of ['BUTTON', 'A', 'SELECT']) {
      expect(noteKey(key('Enter', 'Enter', { target: el({ tagName }) }))).toBeNull()
    }
    expect(noteKey(key('Enter', 'Enter', { shiftKey: true }))).toBeNull()
    expect(noteKey(key('Delete', 'Delete', { metaKey: true }))).toBeNull()
    expect(noteKey(key('d', 'KeyD'))).toBeNull()
    expect(noteKey(key('d', 'KeyD', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(noteKey(key('d', 'KeyD', { metaKey: true, altKey: true }))).toBeNull()
    expect(noteKey(key('d', 'KeyD', { metaKey: true, ctrlKey: true }))).toBeNull()
  })
})

describe('connectKey', () => {
  it('is C on the board, in any layout, without chords or Shift', () => {
    expect(connectKey(key('c', 'KeyC'))).toBe(true)
    expect(connectKey(key('C', 'KeyC', { shiftKey: true }))).toBe(false)
    // A Cyrillic layout: the place of the key.
    expect(connectKey(key('с', 'KeyC'))).toBe(true)
    expect(connectKey(key('c', 'KeyC', { metaKey: true }))).toBe(false)
    expect(connectKey(key('c', 'KeyC', { ctrlKey: true }))).toBe(false)
    expect(connectKey(key('c', 'KeyC', { altKey: true }))).toBe(false)
    expect(connectKey(key('v', 'KeyV'))).toBe(false)
  })

  it('is not C typed into a field or a select', () => {
    expect(connectKey(key('c', 'KeyC', { target: el({ tagName: 'TEXTAREA' }) }))).toBe(false)
    expect(connectKey(key('c', 'KeyC', { target: el({ tagName: 'INPUT', type: 'text' }) }))).toBe(
      false,
    )
    expect(connectKey(key('c', 'KeyC', { target: el({ tagName: 'SELECT' }) }))).toBe(false)
    expect(connectKey(key('c', 'KeyC', { target: el({ tagName: 'BODY' }) }))).toBe(true)
  })
})
