// Check against published Pi declarations, without replacing local dependencies.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = path.join(root, 'node_modules', '.cache', 'pi-wechat-compat', 'packages')
const versions = ['0.73.1', '0.78.0', '0.84.0', '0.84.4', '0.99.2', '1.1.0', '1.2.0', '1.4.0']
const selected = process.argv.slice(2)
if (selected.some(version => !versions.includes(version))) throw new Error('Unsupported compatibility version')

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

async function getPackage(name, version) {
  const directory = path.join(cache, name.replace('/', '-'), version)
  const packageRoot = path.join(directory, 'package')
  const manifestPath = path.join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest = JSON.parse(await download(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`))
    const archive = await download(manifest.dist.tarball)
    const [algorithm, expected] = manifest.dist.integrity.split('-')
    if (createHash(algorithm).update(archive).digest('base64') !== expected) throw new Error(`Integrity failure: ${name}`)
    await fs.mkdir(directory, { recursive: true })
    const archivePath = path.join(directory, 'package.tgz')
    await fs.writeFile(archivePath, archive)
    const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', directory], { stdio: 'inherit' })
    if (extraction.status !== 0) throw new Error(`Cannot extract ${name}@${version}`)
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest.name !== name || manifest.version !== version) throw new Error('Unexpected cached package')
  return { directory: packageRoot, manifest }
}

await fs.mkdir(cache, { recursive: true })
for (const version of selected.length ? selected : versions) {
  const scope = version === '0.73.1' ? '@mariozechner' : '@earendil-works'
  const host = await getPackage(`${scope}/pi-coding-agent`, version)
  const packages = [host]
  for (const [name, requirement] of Object.entries(host.manifest.dependencies)) {
    if (name.startsWith(scope + '/pi-')) {
      packages.push(await getPackage(name, requirement.replace(/^[~^]/, '')))
    }
  }
  const paths = Object.fromEntries(packages.map(pkg => [
    pkg.manifest.name, [path.join(pkg.directory, pkg.manifest.types || 'dist/index.d.ts')],
  ]))
  // All imports are type-only. Check the same extension against each host's API.
  paths['@mariozechner/pi-coding-agent'] = paths[`${scope}/pi-coding-agent`]
  const sentinelPath = path.join(cache, `typed-api-${version}.ts`)
  await fs.writeFile(sentinelPath, `import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from '@mariozechner/pi-coding-agent'
type IsAny<T> = 0 extends (1 & T) ? true : false
const apiIsTyped: IsAny<ExtensionAPI> = false
const contextIsTyped: IsAny<ExtensionContext> = false
const toolsAreTyped: IsAny<Parameters<ExtensionAPI['registerTool']>[0]> = false
const messagesAreTyped: IsAny<Parameters<ExtensionAPI['sendUserMessage']>[0]> = false
type HasSettledEvent = Extract<ExtensionEvent, { type: 'agent_settled' }> extends never ? false : true
type HasProjectTrust = 'isProjectTrusted' extends keyof ExtensionContext ? true : false
const settlementCapabilityMatches: HasProjectTrust extends HasSettledEvent ? true : false = true
type HasBoundaryEvent = Extract<ExtensionEvent, { type: 'agent_before_settle' }> extends never ? false : true
// Check the shared registration return type through an event available on every host.
declare const pi: ExtensionAPI
const registration = pi.on('agent_start', () => {})
type HasUnsubscribe = typeof registration extends (...args: any[]) => any ? true : false
const boundaryCapabilityMatches: HasUnsubscribe extends HasBoundaryEvent ? true : false = true
const expectedSettled: HasSettledEvent = ${!['0.73.1', '0.78.0'].includes(version)}
const expectedBoundary: HasBoundaryEvent = ${!['0.73.1', '0.78.0', '0.84.0', '0.84.4'].includes(version)}
`)
  const configPath = path.join(cache, `tsconfig-${version}.json`)
  await fs.writeFile(configPath, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { paths, noEmit: true },
    include: [path.join(root, 'index.ts'), path.join(root, 'src'), sentinelPath],
    exclude: [],
  }, null, 2))
  process.stdout.write(`Pi ${version}: checking published API types\n`)
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', configPath], {
    cwd: root, stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}
