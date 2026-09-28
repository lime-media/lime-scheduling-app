/**
 * Minimum-cost assignment of routes to trucks (Hungarian algorithm).
 *
 * rows = routes, cols = trucks, rows <= cols. A cost of Infinity means the
 * truck cannot serve that route; the result reports which routes could only be
 * filled that way, so "short by N trucks" is a count, not a guess.
 */

const BLOCKED = 1e12

export type AssignmentResult = {
  /** Column (truck index) per row, or -1 when the row could not be served. */
  colForRow: number[]
  totalCost: number
  unserved: number
}

export function minCostAssignment(cost: number[][]): AssignmentResult {
  const n = cost.length
  if (n === 0) return { colForRow: [], totalCost: 0, unserved: 0 }
  const m0 = cost[0].length
  // Pad with dummy columns so every row can be placed; a dummy costs BLOCKED
  // and marks the row unserved.
  const m = Math.max(m0, n)
  const a = (i: number, j: number) => {
    const v = j < m0 ? cost[i][j] : BLOCKED
    return Number.isFinite(v) ? v : BLOCKED
  }

  // 1-indexed potentials formulation (O(n^2 m)).
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0)
  const way = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(Infinity)
    const used = new Array<boolean>(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const colForRow = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) if (p[j] > 0) colForRow[p[j] - 1] = j - 1
  let totalCost = 0
  let unserved = 0
  for (let i = 0; i < n; i++) {
    const j = colForRow[i]
    if (j < 0 || a(i, j) >= BLOCKED) { colForRow[i] = -1; unserved++ } else totalCost += a(i, j)
  }
  return { colForRow, totalCost, unserved }
}
