import { plugin } from 'bun'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath, dirname } from 'node:path'

// Several deps of jsdom load runtime assets via paths that survive bundling but
// no longer resolve inside `bun build --compile`'s embedded filesystem.
// Two patterns we patch:
//   1. css-tree: `createRequire(import.meta.url) + require('*.json')` → inline JSON.
//   2. jsdom:    `fs.readFileSync(path.resolve(__dirname, '../foo.css'))` → inline the CSS.
const noop = undefined as unknown as { contents: string; loader: 'js' }

const cssTreeJsonInline = {
  name: 'css-tree-json-inline',
  setup(build: Parameters<NonNullable<Parameters<typeof plugin>[0]['setup']>>[0]) {
    build.onLoad({ filter: /css-tree[\\/]lib[\\/].*\.js$/ }, (args: { path: string }) => {
      let src = readFileSync(args.path, 'utf8')
      if (!src.includes('createRequire')) return noop
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
      if (!touched) return noop
      return { contents: src, loader: 'js' as const }
    })
  },
}

const jsdomReadFileInline = {
  name: 'jsdom-readfile-inline',
  setup(build: Parameters<NonNullable<Parameters<typeof plugin>[0]['setup']>>[0]) {
    build.onLoad({ filter: /jsdom[\\/]lib[\\/].*\.js$/ }, (args: { path: string }) => {
      let src = readFileSync(args.path, 'utf8')
      let touched = false
      if (src.includes('readFileSync') && src.includes('__dirname')) {
        src = src.replace(
          /(?:fs|require\(["']node:fs["']\)|require\(["']fs["']\))\.readFileSync\(\s*(?:path\.|require\(["']node:path["']\)\.|require\(["']path["']\)\.)resolve\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)\s*(?:,\s*\{[^}]*\}|,\s*["'][^"']*["'])?\s*\)/g,
          (match, rel: string) => {
            const absPath = resolvePath(dirname(args.path), rel)
            if (!existsSync(absPath)) return match
            const contents = readFileSync(absPath, 'utf8')
            touched = true
            return JSON.stringify(contents)
          },
        )
      }
      // Defuddle never triggers synchronous XHR, but jsdom resolves the worker
      // path at module load. Replace with a placeholder so module init succeeds.
      if (src.includes('require.resolve("./xhr-sync-worker.js")')) {
        src = src.replace(/require\.resolve\(["']\.\/xhr-sync-worker\.js["']\)/g, '"<fetch-md: xhr-sync-worker unavailable>"')
        touched = true
      }
      if (!touched) return noop
      return { contents: src, loader: 'js' as const }
    })
  },
}

const compile = !process.argv.includes('--debug')
const targetArg = process.argv.find((a) => a.startsWith('--target='))?.slice('--target='.length)
const outfileArg = process.argv.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length)
const outfile = outfileArg ?? 'bin/fetch-md'

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: compile ? undefined : 'dist',
  target: 'bun',
  ...(compile
    ? {
        compile: {
          outfile,
          ...(targetArg ? { target: targetArg as 'bun-linux-x64' } : {}),
        },
      }
    : {}),
  plugins: [cssTreeJsonInline, jsdomReadFileInline],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(compile ? `built ${outfile}` : 'wrote dist/index.js')
