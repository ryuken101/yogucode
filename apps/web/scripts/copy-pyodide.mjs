/**
 * Copy Pyodide's boot files out of node_modules and into public/pyodide/.
 *
 * Pyodide is self-hosted rather than loaded from a CDN: it must satisfy the
 * `Cross-Origin-Embedder-Policy: require-corp` header the runtime needs, and a same-origin
 * resource satisfies that automatically. It also keeps a third party out of the path at the
 * one moment that matters — twelve children loading the page at the start of a lesson.
 *
 * The files are *copied* rather than committed. `package.json` pins the version, this
 * script puts it where the browser can fetch it, and `public/pyodide/` is gitignored. That
 * keeps ~13 MB of binaries out of the repository, makes an upgrade a deliberate dependency
 * bump, and behaves identically on a laptop and on Vercel.
 *
 * Run from `predev` and `prebuild`, so it is impossible to start the app without it.
 */

import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Everything `loadPyodide()` fetches to start a bare interpreter — no packages. */
const BOOT_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('pyodide/package.json'))
const target = join(import.meta.dirname, '..', 'public', 'pyodide')

const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))

// A stale copy from a previous version is worse than no copy: the loader would fetch a
// lock file and a wasm blob that disagree, and fail somewhere deep in Emscripten.
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

let bytes = 0
for (const file of BOOT_FILES) {
  await cp(join(source, file), join(target, file))
  bytes += (await readFile(join(target, file))).byteLength
}

// Written so the app can assert at runtime that the files on disk are the version it was
// built against, rather than discovering a mismatch as a boot failure.
await writeFile(join(target, 'VERSION'), `${version}\n`)

console.log(
  `pyodide ${version}: ${BOOT_FILES.length} files, ${(bytes / 1048576).toFixed(1)} MB raw → public/pyodide/`,
)
