// ============================================================================
// Minimal TypeScript loader for spawning real .ts entrypoints with plain
// `node` (Node >= 22.19). Maps relative `.js` imports to the `.ts` sources and
// transpiles with the workspace `typescript` devDependency — no extra runtime
// dependency. Register with:  node --import ./tests/e2e/ts-loader.mjs file.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        try {
          return nextResolve(specifier.slice(0, -3) + '.ts', context)
        } catch {
          throw error
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      const { outputText } = ts.transpileModule(source, {
        fileName: url,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      })
      return { format: 'module', source: outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
