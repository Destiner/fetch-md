#!/usr/bin/env bun
import { spawn } from 'bun'

type Expect = {
  exit?: number | 'nonzero'
  bodyIncludes?: string
  bodyExcludes?: string
  isBinaryNotice?: boolean
  stderrIncludes?: string
}

type Case = {
  name: string
  url: string
  expect: Expect
}

const BINARY_NOTICE = '[binary body omitted'

async function run(url: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn({
    cmd: ['./bin/fetch-md', url],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout, stderr }
}

function check(c: Case, out: { code: number; stdout: string; stderr: string }): string[] {
  const errors: string[] = []
  const { code, stdout, stderr } = out
  const body = stdout

  if (c.expect.exit === 'nonzero') {
    if (code === 0) errors.push(`expected nonzero exit, got 0`)
  } else if (typeof c.expect.exit === 'number') {
    if (code !== c.expect.exit) errors.push(`exit ${code} != ${c.expect.exit}`)
  } else if (code !== 0) {
    errors.push(`unexpected nonzero exit ${code}`)
  }

  if (c.expect.bodyIncludes && !body.includes(c.expect.bodyIncludes)) {
    errors.push(`body missing "${c.expect.bodyIncludes}"`)
  }
  if (c.expect.bodyExcludes && body.includes(c.expect.bodyExcludes)) {
    errors.push(`body unexpectedly contains "${c.expect.bodyExcludes}"`)
  }
  if (c.expect.isBinaryNotice) {
    if (!body.startsWith(BINARY_NOTICE)) errors.push('expected binary notice')
  }
  if (c.expect.stderrIncludes && !stderr.includes(c.expect.stderrIncludes)) {
    errors.push(`stderr missing "${c.expect.stderrIncludes}"`)
  }
  return errors
}

const cases: Case[] = JSON.parse(await Bun.file(process.argv[2] || 'test/cases.json').text())

const concurrency = Number(process.env.CONCURRENCY ?? '6')
const queue = [...cases]
let pass = 0
let fail = 0
const failures: Array<{ name: string; url: string; errors: string[]; stderr: string }> = []
const startedAt = Date.now()

async function worker(_id: number) {
  while (queue.length > 0) {
    const c = queue.shift()
    if (!c) return
    const t0 = Date.now()
    try {
      const out = await run(c.url)
      const errors = check(c, out)
      const dt = Date.now() - t0
      if (errors.length === 0) {
        pass++
        console.log(`PASS  ${c.name}  (${dt}ms)`)
      } else {
        fail++
        failures.push({ name: c.name, url: c.url, errors, stderr: out.stderr.slice(0, 400) })
        console.log(`FAIL  ${c.name}  (${dt}ms)  -- ${errors.join('; ')}`)
      }
    } catch (err) {
      fail++
      const msg = err instanceof Error ? err.message : String(err)
      failures.push({ name: c.name, url: c.url, errors: [msg], stderr: '' })
      console.log(`FAIL  ${c.name}  -- ${msg}`)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))

const dt = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`\n${pass}/${pass + fail} passed in ${dt}s (concurrency=${concurrency})`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) {
    console.log(`  - ${f.name} (${f.url})`)
    for (const e of f.errors) console.log(`      ${e}`)
    if (f.stderr) console.log(`      stderr: ${f.stderr.replace(/\n/g, ' | ').slice(0, 200)}`)
  }
}
process.exit(fail === 0 ? 0 : 1)
