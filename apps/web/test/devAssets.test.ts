import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isId } from '@papertie/core'
import { localAssetUrl, PROTO_ASSET_ID, PROTO_ASSETS } from '../src/dev/assets'
import { assetUrl } from '../src/lib/assets'

const PUBLIC = join(import.meta.dirname, '..', 'public')

describe('local sample assets', () => {
  it('PROTO_ASSET_ID and every prototype asset id are valid, distinct asset ids', () => {
    const ids = [PROTO_ASSET_ID, ...Object.values(PROTO_ASSETS)]
    for (const id of ids) expect(isId(id, 'asset')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('assetUrl picks the size variant of a sample print', () => {
    expect(assetUrl(PROTO_ASSET_ID, 256)).toBe('/textures/print-sample-256.webp')
    expect(assetUrl(PROTO_ASSET_ID, 1024)).toBe('/textures/print-sample-1024.webp')
  })

  it('maps each illustration id to its own file, which exists in both sizes', () => {
    expect(assetUrl(PROTO_ASSETS.lake, 1024)).toBe('/textures/print-lake-1024.webp')
    expect(assetUrl(PROTO_ASSETS.desk, 256)).toBe('/textures/print-desk-256.webp')
    expect(assetUrl(PROTO_ASSETS.field, 1024)).toBe('/textures/print-field-1024.webp')
    for (const id of Object.values(PROTO_ASSETS)) {
      for (const size of [256, 1024] as const) {
        expect(existsSync(join(PUBLIC, assetUrl(id, size)))).toBe(true)
      }
    }
  })

  it('maps the 2560 size to the 1024 file', () => {
    expect(assetUrl(PROTO_ASSETS.desk, 2560)).toBe('/textures/print-desk-1024.webp')
  })

  it('leaves any other id to the server', () => {
    expect(localAssetUrl('asset_00000000000000000000000000', 1024)).toBeNull()
    expect(assetUrl('asset_00000000000000000000000000', 1024)).toBe(
      '/api/assets/asset_00000000000000000000000000/1024',
    )
  })
})
