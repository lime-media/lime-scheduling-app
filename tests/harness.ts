/**
 * Minimal assertion harness.
 *
 * This repo has no test framework. Rather than add one in a PR about pricing,
 * these suites run under the ts-node already present for prisma seeding:
 *
 *     npm test
 *
 * They cover pure functions only — no database, no network — so they run
 * anywhere without credentials.
 */

let pass = 0
let fail = 0
const failures: string[] = []

export function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  FAIL  ${label}\n         got  ${a}\n         want ${e}`)
  }
}

/**
 * Assertions that can only be made after a promise settles. A suite passes
 * its work here and report() waits for it, so an async check is counted
 * rather than running after the process has already exited.
 */
const pending: Promise<unknown>[] = []

export function defer(work: Promise<unknown>): void {
  pending.push(work.catch((err) => {
    fail++
    failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`)
  }))
}

/** Resolves once every deferred assertion has run. */
export async function settle(): Promise<void> {
  await Promise.all(pending)
}

export function section(name: string): void {
  console.log(`\n-- ${name} --`)
}

export function report(): number {
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) console.log(`failing: ${failures.join(', ')}`)
  return fail === 0 ? 0 : 1
}
