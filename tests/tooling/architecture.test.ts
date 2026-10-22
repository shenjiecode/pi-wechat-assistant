import { describe, expect, it } from 'vitest'
import { checkArchitecture } from '../../scripts/check-architecture.mjs'

describe('architecture guard', () => {
  it('excludes named type-only re-exports from runtime cycles', () => {
    expect(checkArchitecture(new Map([
      ['src/shared/a.ts', "export { type B } from './b.js'"],
      ['src/shared/b.ts', "export { type A } from './a.js'"],
    ]))).toEqual([])
  })

  it('allows named type-only Pi re-exports but still checks domain boundaries', () => {
    expect(checkArchitecture(new Map([
      ['src/extension/types.ts', "export { type ExtensionAPI, type ExtensionContext as Context } from '@mariozechner/pi-coding-agent'"],
    ]))).toEqual([])
    expect(checkArchitecture(new Map([
      ['src/shared/a.ts', "export { type B } from '../extension/b.js'"],
      ['src/extension/b.ts', 'export interface B {}'],
    ])).join('\n')).toContain('forbidden dependency')
  })

  it.each(["export { type B, value } from './b.js'", "export * from './b.js'", "export {} from './b.js'"])(
    'keeps runtime edges for %s', (reexport) => {
      expect(checkArchitecture(new Map([
        ['src/shared/a.ts', reexport],
        ['src/shared/b.ts', "import './a.js'"],
      ])).join('\n')).toContain('Runtime dependency cycle')
    },
  )

  it('rejects reverse domain dependencies and runtime cycles', () => {
    const errors = checkArchitecture(new Map([
      ['src/shared/helper.ts', "import '../extension/command.js'"],
      ['src/extension/command.ts', "import '../shared/helper.js'"],
    ]))
    expect(errors.join('\n')).toContain('forbidden dependency')
    expect(errors.join('\n')).toContain('Runtime dependency cycle')
  })

  it('allows only the documented persistence exception', () => {
    expect(checkArchitecture(new Map([
      ['src/messaging/wechat-prompt.ts', "import { getStateDir } from '../bridge/state-storage.js'"],
      ['src/bridge/state-storage.ts', 'export function getStateDir() {}'],
    ]))).toEqual([])
    expect(checkArchitecture(new Map([
      ['src/messaging/wechat-prompt.ts', "import '../bridge/auth.js'"],
      ['src/bridge/auth.ts', ''],
    ])).join('\n')).toContain('forbidden dependency')
  })

  it('checks re-exports, dynamic imports, extensions and Pi runtime imports', () => {
    const errors = checkArchitecture(new Map([
      ['src/shared/helper.ts', "export * from '../extension/command.js'; import('../extension/command.js'); import './missing'; import { ExtensionAPI } from '@mariozechner/pi-coding-agent'"],
      ['src/extension/command.ts', ''],
    ])).join('\n')
    expect(errors).toContain('forbidden dependency')
    expect(errors).toContain('relative imports must use .js')
    expect(errors).toContain('missing or out-of-source import')
    expect(errors).toContain('Pi host imports must be type-only')
  })

  it('allows type-only host APIs without creating runtime cycle edges', () => {
    expect(checkArchitecture(new Map([
      ['src/extension/command.ts', "import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'; import { type ExtensionContext } from '@earendil-works/pi-coding-agent'; import type { B } from './other.js'"],
      ['src/extension/other.ts', "import type { A } from './command.js'"],
    ]))).toEqual([])
  })
})
