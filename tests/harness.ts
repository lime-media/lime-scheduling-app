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

export function section(name: string): void {
  console.log(`\n-- ${name} --`)
}

export function report(): number {
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) console.log(`failing: ${failures.join(', ')}`)
  return fail === 0 ? 0 : 1
}
