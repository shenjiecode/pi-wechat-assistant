// GitHub can display contribution guides outside their source directory.
// Explicit repository URLs also work when the README is rendered on npm.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const prefix = 'https://github.com/shenjiecode/pi-wechat-assistant/blob/main/'
const docs = (await readdir(new URL('docs/', root))).filter(file => file.endsWith('.md'))
const community = (await readdir(new URL('.github/', root))).filter(file => /^(?:CONTRIBUTING|SECURITY|SUPPORT)(?:\.zh)?\.md$/.test(file))
const pages = ['README.md', 'README.zh.md', ...docs.map(file => `docs/${file}`), ...community.map(file => `.github/${file}`)]
let checked = 0

for (const page of pages) {
  const content = await readFile(new URL(page, root), 'utf8')
  const links = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1])
  links.push(...[...content.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]))
  for (const link of links) {
    if (link.startsWith('#')) continue
    assert(/^https?:\/\//.test(link), `${page}: use a full URL for documentation navigation: ${link}`)
    if (!link.startsWith(prefix)) continue
    const target = new URL(link.slice(prefix.length), root)
    target.hash = ''
    target.search = ''
    assert(target.href.startsWith(root.href), `${page}: link escapes the repository: ${link}`)
    assert(existsSync(target), `${page}: missing documentation target: ${link}`)
    checked++
  }
  const translation = page.endsWith('.zh.md') ? page.replace(/\.zh\.md$/, '.md') : page.replace(/\.md$/, '.zh.md')
  assert(content.includes(`](${prefix}${translation})`) || content.includes(`href="${prefix}${translation}"`), `${page}: missing language-switch link`)
}

console.log(`Documentation verified: ${pages.length} pages and ${checked} repository links.`)
