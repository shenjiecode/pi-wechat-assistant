import { configDefaults, defineConfig } from 'vitest/config'

// The extension supports older Node versions; the development Pi SDK requires
// Node >=22.19. Keep its real-runtime tests mandatory in the Node 22/24 CI jobs.
const [major, minor] = process.versions.node.split('.').map(Number)
const supportsPiSdk = major > 22 || (major === 22 && minor >= 19)
if (!supportsPiSdk) {
  console.info('Pi SDK integration tests require Node >=22.19; running extension tests only on this runtime.')
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(supportsPiSdk ? [] : ['tests/integration/new-session.test.ts'])],
    environment: 'node',
  },
})
