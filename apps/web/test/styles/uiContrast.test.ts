import { contrastRatio } from '@papertie/core'
import {
  base,
  colour,
  customProps,
  decl,
  over,
  type Rgba,
  rootVars,
  rule,
  rules,
  sheet,
  toHex,
} from './cssColour'

/**
 * The screen UI as it stands: the sidebar and its selection section, the mini-bar, the
 * "+" sheet, the save dot's popover, the focus chip, ⌘K, settings (with the import dialog), the
 * stage card, the notice slips, the photo slips and the empty hint. One hover, press and focus
 * language across them (tokens.css), and every text and icon on its ground at 4.5:1 or more.
 */
const FILES = [
  'ui/sidebar.css',
  'ui/pickerSheet.css',
  'ui/notePicker.css',
  'ui/emptyHint.css',
  'sync/sync.css',
  'focus/focus.css',
  'search/picker.css',
  'settings/settings.css',
  'app/stage.css',
  'images/photos.css',
] as const

const css = Object.fromEntries(FILES.map((f) => [f, base(sheet(f))])) as Record<
  (typeof FILES)[number],
  string
>

const ROOT = rootVars()

/** The variables a surface's own rule declares, over the page's. */
const scope = (file: (typeof FILES)[number], selector: string) => ({
  ...ROOT,
  ...customProps(rule(css[file], selector)),
})

const PANEL = (file: (typeof FILES)[number], selector: string) =>
  colour(decl(rule(css[file], selector), 'background') as string, ROOT)

interface Pair {
  surface: string
  what: string
  fg: string
  bg: Rgba | string
  vars: Record<string, string>
  /** A wash laid over `bg` first (a pressed or chosen control). */
  wash?: string
}

function ratio(p: Pair): number {
  const bg = typeof p.bg === 'string' ? colour(p.bg, p.vars) : p.bg
  const ground = p.wash === undefined ? bg : over(colour(p.wash, p.vars), bg)
  const fg = over(colour(p.fg, p.vars), ground)
  return contrastRatio(toHex(fg), toHex(ground))
}

const QUIET_HOVER = '.settings-button[data-tone="quiet"]:hover:not(:disabled)'

describe('UI contrast: every text and icon token pair is at least 4.5:1', () => {
  const panel = PANEL('ui/sidebar.css', '.sidebar-sheet')
  const paper = colour('var(--paper-cream)', ROOT)
  const sync = scope('sync/sync.css', '.sync-paper')
  const set = scope('settings/settings.css', '.settings-sheet')
  const stage = scope('app/stage.css', '.stage')
  // Read lazily: a rule that is missing fails its own pair, not the whole file.
  const read = (file: (typeof FILES)[number], sel: string, prop: string) => {
    try {
      return decl(rule(css[file], sel), prop) ?? `missing ${prop} in ${sel}`
    } catch {
      return `missing ${sel}`
    }
  }
  const hoverOf = (file: (typeof FILES)[number], sel: string, prop = 'color') =>
    read(file, sel, prop)
  const pressOf = (file: (typeof FILES)[number], sel: string) => read(file, sel, 'background')

  const pairs: Pair[] = [
    // The sidebar, its selection section and the mini-bar: icons in the UI ink on the panel.
    { surface: 'sidebar', what: 'ink', fg: 'var(--ui-ink)', bg: panel, vars: ROOT },
    {
      surface: 'sidebar',
      what: 'hovered ink',
      fg: hoverOf('ui/sidebar.css', '.sidebar-btn:hover'),
      bg: panel,
      vars: ROOT,
    },
    {
      surface: 'sidebar',
      what: 'pressed (the fibre paper inked)',
      fg: hoverOf('ui/sidebar.css', '.sidebar-btn:hover'),
      bg: panel,
      wash: pressOf('ui/sidebar.css', '.sidebar-btn:active'),
      vars: ROOT,
    },
    {
      surface: 'sidebar',
      what: 'the active tool',
      fg: 'var(--ui-ink)',
      bg: panel,
      wash: pressOf('ui/sidebar.css', '.sidebar-btn[aria-pressed="true"]'),
      vars: ROOT,
    },
    {
      surface: 'sidebar',
      what: 'Delete under the pointer (crimson)',
      fg: hoverOf('ui/sidebar.css', '.sidebar-btn[data-danger]:hover'),
      bg: panel,
      vars: ROOT,
    },
    {
      surface: 'mini-bar',
      what: 'ink',
      fg: read('ui/sidebar.css', '.minibar', 'color'),
      bg: PANEL('ui/sidebar.css', '.minibar'),
      vars: ROOT,
    },
    // The "+" sheet (and Yarn's colours): the panel's material.
    {
      surface: '+ sheet',
      what: 'row titles',
      fg: read('ui/pickerSheet.css', '.sheet-title', 'color'),
      bg: PANEL('ui/pickerSheet.css', '.picker-sheet'),
      vars: ROOT,
    },
    {
      surface: '+ sheet',
      what: 'the chosen style',
      fg: read('ui/pickerSheet.css', '.picker-sheet', 'color'),
      bg: PANEL('ui/pickerSheet.css', '.picker-sheet'),
      wash: pressOf('ui/notePicker.css', '.note-picker-style:has(:checked)'),
      vars: ROOT,
    },
    {
      surface: '+ sheet',
      what: 'Pin, hovered',
      fg: 'var(--paper-cream)',
      bg: pressOf('ui/notePicker.css', '.note-picker-pin:hover'),
      vars: ROOT,
    },
    // The save dot's popover, the notice slips and the focus chip: cream fibre paper.
    { surface: 'save popover', what: 'ink', fg: 'var(--sync-ink)', bg: paper, vars: sync },
    { surface: 'save popover', what: 'muted', fg: 'var(--sync-muted)', bg: paper, vars: sync },
    { surface: 'save popover', what: 'error', fg: 'var(--sync-error)', bg: paper, vars: sync },
    {
      surface: 'notices',
      what: 'close, hovered',
      fg: hoverOf('sync/sync.css', '.sync-slip-close:hover'),
      bg: paper,
      vars: sync,
    },
    {
      surface: 'notices',
      what: 'close, pressed',
      fg: hoverOf('sync/sync.css', '.sync-slip-close:hover'),
      bg: paper,
      wash: pressOf('sync/sync.css', '.sync-slip-close:active'),
      vars: sync,
    },
    {
      surface: 'focus chip',
      what: 'the pressed text button',
      fg: 'var(--ui-ink)',
      bg: paper,
      wash: pressOf('focus/focus.css', '.focus-chip-text[aria-pressed="true"]'),
      vars: sync,
    },
    {
      surface: 'focus chip',
      what: 'Esc, hovered',
      fg: hoverOf('focus/focus.css', '.focus-chip-exit:hover'),
      bg: paper,
      vars: sync,
    },
    // ⌘K.
    {
      surface: '⌘K',
      what: 'the query',
      fg: read('search/picker.css', '.picker-input', 'color'),
      bg: pressOf('search/picker.css', '.picker-input'),
      vars: sync,
    },
    {
      surface: '⌘K',
      what: 'the placeholder',
      fg: read('search/picker.css', '.picker-input::placeholder', 'color'),
      bg: pressOf('search/picker.css', '.picker-input'),
      vars: sync,
    },
    {
      surface: '⌘K',
      what: 'the chosen row',
      fg: 'var(--sync-ink)',
      bg: paper,
      wash: pressOf('search/picker.css', '.picker-row[aria-selected="true"]'),
      vars: sync,
    },
    // Settings, with the import dialog (its inks on paper and field: test/settings/contrast).
    {
      surface: 'settings',
      what: 'a tab, hovered',
      fg: hoverOf('settings/settings.css', '.settings-tab:hover'),
      bg: paper,
      vars: set,
    },
    {
      surface: 'settings',
      what: 'a tab, pressed',
      fg: hoverOf('settings/settings.css', '.settings-tab:hover'),
      bg: paper,
      wash: pressOf('settings/settings.css', '.settings-tab:active'),
      vars: set,
    },
    {
      surface: 'settings',
      what: 'the ink button, hovered',
      fg: 'var(--paper-cream)',
      bg: pressOf('settings/settings.css', '.settings-button:hover:not(:disabled)'),
      vars: set,
    },
    // A quiet button keeps its own paper under the pointer: the ink button's hover fill ranks
    // above the quiet tone's ground, so the quiet hover names its ground itself.
    {
      surface: 'settings',
      what: 'a quiet button',
      fg: read('settings/settings.css', '.settings-button[data-tone="quiet"]', 'color'),
      bg: read('settings/settings.css', '.settings-button[data-tone="quiet"]', 'background'),
      vars: set,
    },
    {
      surface: 'settings',
      what: 'a quiet button, hovered',
      fg: hoverOf('settings/settings.css', QUIET_HOVER),
      bg: read('settings/settings.css', QUIET_HOVER, 'background'),
      vars: set,
    },
    {
      surface: 'settings',
      what: 'a quiet button, pressed',
      fg: hoverOf('settings/settings.css', QUIET_HOVER),
      bg: pressOf(
        'settings/settings.css',
        '.settings-button[data-tone="quiet"]:active:not(:disabled)',
      ),
      vars: set,
    },
    {
      surface: 'settings',
      what: 'the crimson button, hovered',
      fg: read('settings/settings.css', '.settings-button[data-tone="danger"]', 'color'),
      bg: pressOf(
        'settings/settings.css',
        '.settings-button[data-tone="danger"]:hover:not(:disabled)',
      ),
      vars: set,
    },
    // The stage card (the board could not open, say): cream fibre paper with an ink button.
    { surface: 'stage card', what: 'ink', fg: 'var(--stage-ink)', bg: paper, vars: stage },
    { surface: 'stage card', what: 'muted lead', fg: 'var(--stage-muted)', bg: paper, vars: stage },
    {
      surface: 'stage card',
      what: 'the ink button',
      fg: read('app/stage.css', '.stage-button', 'color'),
      bg: read('app/stage.css', '.stage-button', 'background'),
      vars: stage,
    },
    {
      surface: 'stage card',
      what: 'the ink button, hovered',
      fg: 'var(--paper-cream)',
      bg: pressOf('app/stage.css', '.stage-button:hover:not(:disabled)'),
      vars: stage,
    },
    // The empty board's hint.
    {
      surface: 'empty hint',
      what: 'subtitle',
      fg: read('ui/emptyHint.css', '.empty-hint-subtitle', 'color'),
      bg: paper,
      vars: ROOT,
    },
  ]

  for (const p of pairs) {
    it(`${p.surface}: ${p.what}`, () => {
      expect(ratio(p)).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('the focus ring stands 3:1 off every ground it is drawn on', () => {
    for (const ground of [panel, paper, colour('var(--set-field)', set)]) {
      const ring = over(colour('var(--focus-ring)', ROOT), ground)
      expect(contrastRatio(toHex(ring), toHex(ground))).toBeGreaterThanOrEqual(3)
    }
  })
})

/** Controls whose hover keeps its own colour, by design. */
const HOVER_EXCEPTIONS = new Set([
  // Delete turns crimson under the pointer (visual-language "Sidebar").
  '.sidebar-btn[data-danger]:hover',
])

/** Focus rules that draw no ring: the board's own items and holders, each with its own mark. */
const RINGLESS = new Set(['.picker-sheet:focus', '.viewport:focus'])

describe('one hover, press and focus language', () => {
  const all = FILES.flatMap((f) => rules(css[f]).map(([sels, body]) => ({ f, sels, body })))

  it('every keyboard focus is the shared indigo ring, 2 px, 2 px out', () => {
    const tokens = rule(base(sheet('styles/tokens.css')), ':root')
    expect(decl(tokens, '--focus-ring-width')).toBe('2px')
    expect(decl(tokens, '--focus-ring-offset')).toBe('2px')
    expect(decl(tokens, '--focus-outline')).toBe('var(--focus-ring-width) solid var(--focus-ring)')
    const focusRules = all.filter(({ sels }) => sels.some((s) => /:focus(-visible)?\b/.test(s)))
    expect(focusRules.length).toBeGreaterThan(10)
    const bad: string[] = []
    for (const { f, sels, body } of focusRules) {
      const outline = decl(body, 'outline')
      if (outline === undefined) continue
      if (sels.every((s) => RINGLESS.has(s)) && outline === 'none') continue
      if (outline !== 'var(--focus-outline)') bad.push(`${f}: ${sels.join(', ')}: ${outline}`)
      const offset = decl(body, 'outline-offset')
      if (offset !== 'var(--focus-ring-offset)') bad.push(`${f}: ${sels.join(', ')}: ${offset}`)
    }
    expect(bad).toEqual([])
  })

  it('hover moves the ink by --hover-ink (darker) or --hover-ink-on-dark (an ink fill, lighter)', () => {
    const tokens = rule(base(sheet('styles/tokens.css')), ':root')
    expect(decl(tokens, '--hover-ink')).toBe('15%')
    expect(decl(tokens, '--hover-ink-on-dark')).toBe('12%')
    const hovers = all.filter(({ sels }) => sels.some((s) => s.includes(':hover')))
    expect(hovers.length).toBeGreaterThan(15)
    const bad: string[] = []
    for (const { f, sels, body } of hovers) {
      if (sels.every((s) => HOVER_EXCEPTIONS.has(s))) continue
      if (!/var\(--hover-ink(-on-dark)?\)/.test(body)) {
        bad.push(`${f}: ${sels.join(', ')}: no --hover-ink`)
      }
      if (body.includes('--press-wash')) bad.push(`${f}: ${sels.join(', ')}: a press on hover`)
    }
    expect(bad).toEqual([])
  })

  it('a press inks the fibre paper: every quiet control has an :active wash, every ink button sinks', () => {
    const tokens = rule(base(sheet('styles/tokens.css')), ':root')
    expect(decl(tokens, '--press-wash')).toMatch(
      /^color-mix\(in srgb, var\(--ink-cream\) \d+%, transparent\)$/,
    )
    const quiet: Array<[(typeof FILES)[number], string]> = [
      ['ui/sidebar.css', '.sidebar-btn:active'],
      ['ui/sidebar.css', '.sidebar-mark:active'],
      ['ui/notePicker.css', '.note-picker-style:active'],
      ['sync/sync.css', '.save-dot:active'],
      ['sync/sync.css', '.sync-slip-close:active'],
      ['sync/sync.css', '.sync-text-button:active'],
      ['focus/focus.css', '.focus-chip-step:active:not([aria-disabled="true"])'],
      ['focus/focus.css', '.focus-chip-text:active'],
      ['focus/focus.css', '.focus-chip-exit:active'],
      ['settings/settings.css', '.settings-tab:active'],
      ['settings/settings.css', '.settings-close:active'],
      ['settings/settings.css', '.settings-chip-input:active:not(:checked) + .settings-chip-face'],
      ['app/stage.css', '.route-link:active'],
      ['images/photos.css', '.photo-retry:active'],
    ]
    for (const [f, sel] of quiet) {
      expect(decl(rule(css[f], sel), 'background'), `${f}: ${sel}`).toBe('var(--press-wash)')
    }
    const ink: Array<[(typeof FILES)[number], string]> = [
      ['ui/notePicker.css', '.note-picker-pin:active'],
      ['sync/sync.css', '.sync-button:active:not(:disabled)'],
      ['settings/settings.css', '.settings-button:active:not(:disabled)'],
      ['app/stage.css', '.stage-button:active:not(:disabled)'],
      ['ui/sidebar.css', '.sidebar-add:active'],
    ]
    for (const [f, sel] of ink) {
      expect(decl(rule(css[f], sel), 'box-shadow'), `${f}: ${sel}`).toBeDefined()
    }
  })

  it('prefers-contrast: more lifts the UI ink to full ink and takes the fibre away', () => {
    const tokens = sheet('styles/tokens.css')
    const more = /@media \(prefers-contrast: more\)\s*\{([\s\S]*?\n)\}/.exec(tokens)?.[1] ?? ''
    const vars = customProps(more)
    expect(vars['--ui-ink']).toBe('var(--ink-cream)')
    expect(vars['--ui-muted']).toBe('var(--ink-cream)')
    const fibres = Object.entries(vars).filter(([k]) => k === '--fibre' || k.startsWith('--fibre-'))
    for (const [, v] of fibres) expect(v).toBe('none')
    expect(fibres.length).toBe(9)
    // The surfaces' muted inks are the UI's, so they follow it.
    expect(customProps(rule(css['sync/sync.css'], '.sync-paper'))['--sync-muted']).toBe(
      'var(--ui-muted)',
    )
    expect(customProps(rule(css['settings/settings.css'], '.settings-sheet'))['--set-muted']).toBe(
      'var(--ui-muted)',
    )
    expect(customProps(rule(css['app/stage.css'], '.stage'))['--stage-muted']).toBe(
      'var(--ui-muted)',
    )
    expect(decl(rule(css['ui/sidebar.css'], '.sidebar-sheet'), 'color')).toBe('var(--ui-ink)')
  })

  it('every kind of button visibly changes under the pointer: rest and hover 1.15:1 or more', () => {
    const sync = { ...ROOT, ...customProps(rule(css['sync/sync.css'], '.sync-paper')) }
    const set = { ...ROOT, ...customProps(rule(css['settings/settings.css'], '.settings-sheet')) }
    const stage = { ...ROOT, ...customProps(rule(css['app/stage.css'], '.stage')) }
    const sb = { ...ROOT, ...customProps(rule(css['ui/sidebar.css'], '.sidebar')) }
    const save = { ...sync, ...customProps(rule(css['sync/sync.css'], '.save-dot')) }
    const panel = colour(
      decl(rule(css['ui/sidebar.css'], '.sidebar-sheet'), 'background') as string,
      ROOT,
    )
    const paper = colour('var(--paper-cream)', ROOT)
    const get = (f: (typeof FILES)[number], sel: string, prop: string) => {
      try {
        return decl(rule(css[f], sel), prop) ?? `missing ${prop} in ${sel}`
      } catch {
        return `missing ${sel}`
      }
    }
    // [what, rest colour, hover colour, the variables they read, the ground under them]
    const kinds: Array<[string, string, string, Record<string, string>, Rgba]> = [
      [
        'sidebar icon',
        'var(--ui-ink)',
        get('ui/sidebar.css', '.sidebar-btn:hover', 'color'),
        ROOT,
        panel,
      ],
      [
        'the mark',
        get('ui/sidebar.css', '.sidebar-mark', 'color'),
        get('ui/sidebar.css', '.sidebar-mark:hover', 'color'),
        sb,
        panel,
      ],
      [
        'the "+" disc',
        get('ui/sidebar.css', '.sidebar-add', 'background'),
        get('ui/sidebar.css', '.sidebar-add:hover', 'background'),
        sb,
        panel,
      ],
      [
        'a style pill',
        'var(--ui-ink)',
        get('ui/notePicker.css', '.note-picker-style:hover', 'color'),
        ROOT,
        panel,
      ],
      [
        'Pin (ink)',
        get('ui/notePicker.css', '.note-picker-pin', 'background'),
        get('ui/notePicker.css', '.note-picker-pin:hover', 'background'),
        ROOT,
        panel,
      ],
      [
        'the save dot',
        get('sync/sync.css', '.save-dot', '--dot-ink'),
        get('sync/sync.css', '.save-dot:hover', '--dot-ink'),
        save,
        panel,
      ],
      [
        'a sync button (ink)',
        get('sync/sync.css', '.sync-button', 'background'),
        get('sync/sync.css', '.sync-button:hover:not(:disabled)', 'background'),
        sync,
        paper,
      ],
      [
        'a text button (its underline)',
        get('sync/sync.css', '.sync-text-button', 'text-decoration-color'),
        'var(--sync-ink)',
        sync,
        paper,
      ],
      [
        'a slip’s close',
        get('sync/sync.css', '.sync-slip-close', 'color'),
        get('sync/sync.css', '.sync-slip-close:hover', 'color'),
        sync,
        paper,
      ],
      [
        'a focus chip step',
        get('focus/focus.css', '.focus-chip-step', 'color'),
        get('focus/focus.css', '.focus-chip-step:hover:not([aria-disabled="true"])', 'color'),
        sync,
        paper,
      ],
      [
        'the focus chip’s Esc',
        get('focus/focus.css', '.focus-chip-exit', 'color'),
        get('focus/focus.css', '.focus-chip-exit:hover', 'color'),
        sync,
        paper,
      ],
      [
        '⌘K’s field (its hairline)',
        get('search/picker.css', '.picker-input', 'border'),
        get('search/picker.css', '.picker-input:hover', 'border-color'),
        sync,
        paper,
      ],
      [
        'a settings tab',
        'var(--set-muted)',
        get('settings/settings.css', '.settings-tab:hover', 'color'),
        set,
        paper,
      ],
      [
        'settings close',
        get('settings/settings.css', '.settings-close', 'color'),
        get('settings/settings.css', '.settings-close:hover', 'color'),
        set,
        paper,
      ],
      [
        'a settings button (ink)',
        get('settings/settings.css', '.settings-button', 'background'),
        get('settings/settings.css', '.settings-button:hover:not(:disabled)', 'background'),
        set,
        paper,
      ],
      [
        'a quiet button (its hairline)',
        'var(--set-rule)',
        get(
          'settings/settings.css',
          '.settings-button[data-tone="quiet"]:hover:not(:disabled)',
          'box-shadow',
        ),
        set,
        paper,
      ],
      [
        'a danger button',
        'var(--set-error)',
        get(
          'settings/settings.css',
          '.settings-button[data-tone="danger"]:hover:not(:disabled)',
          'background',
        ),
        set,
        paper,
      ],
      [
        'a settings chip',
        get('settings/settings.css', '.settings-chip-face', 'color'),
        get(
          'settings/settings.css',
          '.settings-chip-input:hover:not(:checked) + .settings-chip-face',
          'color',
        ),
        set,
        paper,
      ],
      [
        'a settings field (its hairline)',
        'var(--set-rule)',
        get('settings/settings.css', '.settings-input:hover', 'border-color'),
        set,
        paper,
      ],
      [
        'the stage button (ink)',
        get('app/stage.css', '.stage-button', 'background'),
        get('app/stage.css', '.stage-button:hover:not(:disabled)', 'background'),
        stage,
        paper,
      ],
      [
        'an in-app link (its underline)',
        get('app/stage.css', '.route-link', 'text-decoration-color'),
        'var(--ink-cream)',
        stage,
        paper,
      ],
      [
        'a photo slip’s action',
        get('images/photos.css', '.photo-retry-act', 'color'),
        get('images/photos.css', '.photo-retry:hover .photo-retry-act', 'color'),
        ROOT,
        paper,
      ],
      [
        'Add photo (its paper)',
        get('images/photos.css', '.photo-add', 'background'),
        get('images/photos.css', '.photo-add:hover', 'background'),
        ROOT,
        paper,
      ],
    ]
    const colourIn = (expr: string, vars: Record<string, string>) => {
      // A border or inset hairline: its colour is the last word.
      const m = /(?:\d+px solid |inset 0 0 0 1px )(.+)$/.exec(expr)
      return colour(m ? (m[1] as string) : expr, vars)
    }
    const weak: string[] = []
    for (const [what, rest, hover, vars, ground] of kinds) {
      try {
        const a = toHex(over(colourIn(rest, vars), ground))
        const b = toHex(over(colourIn(hover, vars), ground))
        const r = contrastRatio(a, b)
        if (r < 1.15) weak.push(`${what}: ${a} -> ${b} is ${r.toFixed(3)}:1`)
      } catch (e) {
        weak.push(`${what}: ${(e as Error).message}`)
      }
    }
    expect(weak).toEqual([])
  })
})

describe('a settings button’s tone keeps its own ground in every state', () => {
  const sheetCss = css['settings/settings.css']
  const TONES = ['quiet', 'danger'] as const

  it('each tone’s hover names its background: the ink button’s hover fill outranks a tone’s rest rule', () => {
    // `.settings-button:hover:not(:disabled)` (0,3,0) is above `.settings-button[data-tone]` (0,2,0).
    expect(
      decl(rule(sheetCss, '.settings-button:hover:not(:disabled)'), 'background'),
    ).toBeDefined()
    for (const tone of TONES) {
      const rest = decl(rule(sheetCss, `.settings-button[data-tone="${tone}"]`), 'background')
      const hover = decl(
        rule(sheetCss, `.settings-button[data-tone="${tone}"]:hover:not(:disabled)`),
        'background',
      )
      expect(rest, tone).toBeDefined()
      expect(hover, tone).toBeDefined()
    }
  })

  it('a quiet button under the pointer is on its own paper, not the ink button’s fill', () => {
    const vars = scope('settings/settings.css', '.settings-sheet')
    const bg = (sel: string) =>
      toHex(colour(decl(rule(sheetCss, sel), 'background') as string, vars))
    expect(bg('.settings-button[data-tone="quiet"]:hover:not(:disabled)')).toBe(
      bg('.settings-button[data-tone="quiet"]'),
    )
  })
})
