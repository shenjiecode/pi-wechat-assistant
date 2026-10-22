// Guard the existing domain boundaries without introducing another toolchain.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const domains = {
  extension: ['extension', 'bridge', 'wechat', 'messaging', 'shared'],
  bridge: ['bridge', 'wechat', 'messaging', 'shared'],
  wechat: ['wechat', 'shared'],
  messaging: ['messaging', 'shared'],
  shared: ['shared'],
}
// Deliberate persistence dependencies; do not open the entire bridge layer.
const persistenceEdges = new Set([
  'src/wechat/client.ts -> src/bridge/transport-state.ts',
  'src/messaging/wechat-prompt.ts -> src/bridge/state-storage.ts',
])

export function checkArchitecture(sources) {
  const errors = []
  const graph = new Map()
  for (const [file, content] of sources) {
    const domain = file.split('/')[1]
    if (!domains[domain]) { errors.push(`${file}: unknown source domain`); continue }
    const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const edges = []
    graph.set(file, edges)
    function inspect(node) {
      let specifier
      let typeOnly = false
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier
        typeOnly = ts.isImportDeclaration(node)
          ? !!node.importClause?.isTypeOnly || (!!node.importClause && !node.importClause.name
            && !!node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
            && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly))
          : node.isTypeOnly
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0]
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text
        if (/^@(?:mariozechner|earendil-works)\/pi-/.test(name) && !typeOnly) {
          errors.push(`${file}: Pi host imports must be type-only: ${name}`)
        }
        if (name.startsWith('.')) {
          if (!name.endsWith('.js')) errors.push(`${file}: relative imports must use .js: ${name}`)
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), name)).replace(/\.js$/, '.ts')
          if (!sources.has(target)) errors.push(`${file}: missing or out-of-source import: ${name}`)
          else {
            if (!domains[domain].includes(target.split('/')[1]) && !persistenceEdges.has(`${file} -> ${target}`)) {
              errors.push(`${file}: forbidden dependency on ${target}`)
            }
            if (!typeOnly) edges.push(target)
          }
        }
      }
      ts.forEachChild(node, inspect)
    }
    inspect(parsed)
  }
  const visited = new Set()
  const active = new Set()
  function visit(file, trail) {
    if (active.has(file)) { errors.push(`Runtime dependency cycle: ${[...trail, file].join(' -> ')}`); return }
    if (visited.has(file)) return
    visited.add(file)
    active.add(file)
    for (const target of graph.get(file) ?? []) visit(target, [...trail, file])
    active.delete(file)
  }
  for (const file of graph.keys()) visit(file, [])
  return errors
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const sources = new Map()
  async function collect(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`
      if (entry.isDirectory()) await collect(name)
      else if (name.endsWith('.ts')) sources.set(name, await readFile(path.join(root, name), 'utf8'))
    }
  }
  await collect('src')
  const errors = checkArchitecture(sources)
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Architecture verified: ${sources.size} source files, allowed domain edges, type-only Pi imports, no runtime cycles.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
