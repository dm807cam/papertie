import { asarFiles, binaryTarget, problems } from '../scripts/checkPackages.mjs'

/** An asar's first bytes: the pickle sizes, then its JSON header. */
function asar(header: object): Buffer {
  const json = Buffer.from(JSON.stringify(header))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(json.length + 8, 4)
  head.writeUInt32LE(json.length + 4, 8)
  head.writeUInt32LE(json.length, 12)
  return Buffer.concat([head, json])
}

function machO(cpu: number): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(cpu, 4)
  return b
}
function elf(machine: number): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(0x7f454c46, 0)
  b.writeUInt16LE(machine, 18)
  return b
}
function pe(machine: number): Buffer {
  const b = Buffer.alloc(256)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.write('PE\0\0', 0x80, 'latin1')
  b.writeUInt16LE(machine, 0x84)
  return b
}

const APP = [
  'package.json',
  'dist/main.cjs',
  'dist/preload.cjs',
  'dist/icon.png',
  'dist/web/index.html',
]
const linuxX64 = { platform: 'linux', arch: 'x64' }
const files = (paths: string[], unpacked: string[] = []) =>
  paths.map((path) => ({ path, unpacked: unpacked.includes(path) }))
const BINDING = 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node'

describe('the packed app, checked', () => {
  it('reads the files and the unpacked marks from an asar header', () => {
    const buf = asar({
      files: {
        'package.json': { size: 2, offset: '0' },
        node_modules: { files: { a: { files: { 'b.node': { size: 1, unpacked: true } } } } },
      },
    })
    expect(asarFiles(buf)).toEqual([
      { path: 'package.json', unpacked: false },
      { path: 'node_modules/a/b.node', unpacked: true },
    ])
  })

  it("tells a native binary's OS and CPU", () => {
    expect(binaryTarget(machO(0x0100000c))).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(binaryTarget(machO(0x01000007))).toEqual({ platform: 'darwin', arch: 'x64' })
    expect(binaryTarget(elf(62))).toEqual({ platform: 'linux', arch: 'x64' })
    expect(binaryTarget(elf(183))).toEqual({ platform: 'linux', arch: 'arm64' })
    expect(binaryTarget(pe(0x8664))).toEqual({ platform: 'win32', arch: 'x64' })
    expect(binaryTarget(Buffer.alloc(64))).toBeNull()
  })

  it("passes the app with the target's own sharp, unpacked", () => {
    const all = files(
      [...APP, BINDING, 'node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so'],
      [BINDING],
    )
    expect(problems(all, linuxX64, () => elf(62))).toEqual([])
  })

  it("names what does not belong: account code, dev files, another target's sharp", () => {
    const all = files(
      [
        ...APP,
        BINDING,
        'node_modules/better-sqlite3/lib/index.js',
        'node_modules/nodemailer/lib/index.js',
        'dist/main.cjs.map',
        'node_modules/sharp/src/sharp.cc',
        'node_modules/@img/sharp-darwin-arm64/lib/x.node',
      ],
      [BINDING, 'node_modules/@img/sharp-darwin-arm64/lib/x.node'],
    )
    expect(
      problems(all, linuxX64, (p) => (p.includes('darwin') ? machO(0x0100000c) : elf(62))),
    ).toEqual([
      'account code: node_modules/better-sqlite3/lib/index.js',
      'account code: node_modules/nodemailer/lib/index.js',
      'dev file: dist/main.cjs.map',
      'dev file: node_modules/sharp/src/sharp.cc',
      "another target's sharp: @img/sharp-darwin-arm64",
      'node_modules/@img/sharp-darwin-arm64/lib/x.node is built for darwin-arm64',
    ])
  })

  it('names a missing app file, a missing or packed binding, and one built for another CPU', () => {
    expect(problems(files(APP.slice(1)), linuxX64, () => elf(62))).toEqual([
      'missing package.json',
      'no @img/sharp-linux-x64',
      'no native binding',
    ])
    expect(problems(files([...APP, BINDING]), linuxX64, () => elf(62))).toEqual([
      `packed in the asar, not unpacked: ${BINDING}`,
    ])
    expect(problems(files([...APP, BINDING], [BINDING]), linuxX64, () => elf(183))).toEqual([
      `${BINDING} is built for linux-arm64`,
    ])
  })
})
