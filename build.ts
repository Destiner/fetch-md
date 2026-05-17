import { plugin } from 'bun'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath, dirname } from 'node:path'

// css-tree (transitive dep of jsdom) loads JSON data via `createRequire(import.meta.url)`.
// That pattern survives bundling and breaks `bun build --compile` because the JSON path
// no longer exists at runtime inside the embedded filesystem. This plugin rewrites
// every css-tree module that uses createRequire+require(*.json) so the JSON content
// is inlined as a static literal.
const cssTreeJsonInline = {
  name: 'css-tree-json-inline',
  setup(build: Parameters<NonNullable<Parameters<typeof plugin>[0]['setup']>>[0]) {
    build.onLoad({ filter: /css-tree[\\/]lib[\\/].*\.js$/ }, (args: { path: string }) => {
      let src = readFileSync(args.path, 'utf8')
      if (!src.includes('createRequire')) return undefined as unknown as { contents: string; loader: 'js' }
      let touched = false
      src = src.replace(
        /import \{ createRequire(?: as \w+)? \} from ["']module["'];?\s*/g,
        () => {
          touched = true
          return ''
        },
      )
      src = src.replace(/const (\w+) = createRequire\(import\.meta\.url\);?\s*/g, () => {
        touched = true
        return ''
      })
      src = src.replace(/\b\w+\(["'](\.[^"']+\.json)["']\)/g, (match, rel: string) => {
        const jsonPath = resolvePath(dirname(args.path), rel)
        if (!existsSync(jsonPath)) return match
        const json = readFileSync(jsonPath, 'utf8')
        touched = true
        return `(${json})`
      })
      if (!touched) return undefined as unknown as { contents: string; loader: 'js' }
      return { contents: src, loader: 'js' as const }
    })
  },
}

const compile = !process.argv.includes('--debug')

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: compile ? undefined : 'dist',
  target: 'bun',
  ...(compile ? { compile: { outfile: 'bin/fetch-md' } } : {}),
  plugins: [cssTreeJsonInline],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(compile ? 'built bin/fetch-md' : 'wrote dist/index.js')
