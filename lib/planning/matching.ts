/**
 * Pair areas onto trucks: as many pairs as possible, then the shortest hops.
 *
 * This is maximum-cardinality, minimum-weight matching on a general graph. The
 * textbook answer is Edmonds' blossom algorithm; we do not need it. The graph
 * only has edges between areas within one truck-hop of each other, so it falls
 * apart into small regional clusters, and each cluster is solved exactly with a
 * memoised search over "who is still unpaired". Ordering a cluster's nodes by
 * reverse Cuthill–McKee keeps that state small.
 *
 * The search state is a BigInt bitmask, so there is no size cutoff. What
 * bounds the work is the cluster's bandwidth in that order — how far ahead of
 * a node its furthest neighbour sits — because the state only has to remember
 * pairings within that window: at most k × 2^bandwidth states. So:
 *
 *   1. Precheck. If that bound is over MEMO_LIMIT, skip straight to greedy.
 *      No time is spent discovering the limit by running into it.
 *   2. Budget. The exact search also stops at MEMO_LIMIT states or
 *      TIME_BUDGET_MS, whichever comes first, and falls back to greedy.
 *
 * Either fallback is counted in greedyClusters and surfaced as a warning, so a
 * sub-optimal answer is never silent. Real footprints sit far inside the
 * bound: 44 areas at a 250-mile hop solve exactly in milliseconds.
 */

export type MatchEdge = { a: number; b: number; miles: number }

export type MatchResult = {
  pairs: MatchEdge[]
  /** Clusters solved greedily because the exact search grew too large. */
  greedyClusters: number
}

const MEMO_LIMIT = 500_000
const TIME_BUDGET_MS = 1_500
const PAIR_VALUE = 1e7 // one more pair always beats any saving in miles

export function maxPairing(n: number, edges: MatchEdge[]): MatchResult {
  const adj: MatchEdge[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    adj[e.a].push(e)
    adj[e.b].push({ a: e.b, b: e.a, miles: e.miles })
  }

  // Connected components, each in reverse Cuthill–McKee order: breadth-first
  // from a low-degree node, visiting neighbours lowest-degree first, then
  // reversed. It is the standard ordering for keeping every node's neighbours
  // close to it in the list, which is exactly what bounds the search state.
  const degree = adj.map(a => a.length)
  const comp = new Array<number>(n).fill(-1)
  const components: number[][] = []
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue
    const members: number[] = []
    const stack = [s]
    comp[s] = components.length
    while (stack.length) {
      const v = stack.pop()!
      members.push(v)
      for (const e of adj[v]) if (comp[e.b] === -1) { comp[e.b] = components.length; stack.push(e.b) }
    }
    const start = members.reduce((best, v) => (degree[v] < degree[best] ? v : best), members[0])
    const seen = new Set([start])
    const order: number[] = []
    const queue = [start]
    while (queue.length) {
      const v = queue.shift()!
      order.push(v)
      const next = adj[v].map(e => e.b).filter(u => !seen.has(u)).sort((x, y) => degree[x] - degree[y])
      for (const u of next) if (!seen.has(u)) { seen.add(u); queue.push(u) }
    }
    components.push(order.reverse())
  }

  const pairs: MatchEdge[] = []
  let greedyClusters = 0
  for (const nodes of components) {
    if (nodes.length < 2) continue
    const exact = solveExact(nodes, adj)
    if (exact) pairs.push(...exact)
    else { greedyClusters++; pairs.push(...solveGreedy(nodes, adj)) }
  }
  return { pairs, greedyClusters }
}

function solveExact(nodes: number[], adj: MatchEdge[][]): MatchEdge[] | null {
  const k = nodes.length
  const local = new Map(nodes.map((v, i) => [v, i]))
  // Neighbours by local index, only those later in the order (earlier ones
  // have already decided).
  const fwd: { j: number; miles: number; edge: MatchEdge }[][] = nodes.map((v, i) =>
    adj[v]
      .map(e => ({ j: local.get(e.b)!, miles: e.miles, edge: e }))
      .filter(x => x.j > i)
      .sort((x, y) => x.miles - y.miles),
  )

  // Precheck: the state space is bounded by k × 2^bandwidth.
  const bandwidth = Math.max(0, ...fwd.map((list, i) => list.reduce((m, x) => Math.max(m, x.j - i), 0)))
  if (bandwidth >= 40 || k * 2 ** bandwidth > MEMO_LIMIT) return null

  const memo = new Map<string, { value: number; pick: number }>()
  let aborted = false
  const deadline = Date.now() + TIME_BUDGET_MS
  const bit = (n: number) => BigInt(1) << BigInt(n)
  const keyOf = (i: number, taken: bigint) => `${i}:${(taken >> BigInt(i + 1)).toString(36)}`

  // State: position i, plus which later nodes are already paired (bitmask).
  const solve = (i: number, taken: bigint): number => {
    if (aborted) return 0
    if (i >= k) return 0
    if (taken & bit(i)) return solve(i + 1, taken)
    const key = keyOf(i, taken)
    const hit = memo.get(key)
    if (hit) return hit.value
    if (memo.size > MEMO_LIMIT || (memo.size % 4096 === 0 && Date.now() > deadline)) { aborted = true; return 0 }

    let best = solve(i + 1, taken) // leave i unpaired
    let pick = -1
    for (let x = 0; x < fwd[i].length; x++) {
      const { j, miles } = fwd[i][x]
      if (taken & bit(j)) continue
      const v = PAIR_VALUE - miles + solve(i + 1, taken | bit(j))
      if (v > best) { best = v; pick = x }
    }
    memo.set(key, { value: best, pick })
    return best
  }

  solve(0, BigInt(0))
  if (aborted) return null

  // Walk the memo to recover the chosen pairs.
  const out: MatchEdge[] = []
  let taken = BigInt(0)
  for (let i = 0; i < k; i++) {
    if (taken & bit(i)) continue
    const hit = memo.get(keyOf(i, taken))
    if (!hit || hit.pick < 0) continue
    const { j, edge } = fwd[i][hit.pick]
    taken |= bit(j)
    out.push({ a: Math.min(edge.a, edge.b), b: Math.max(edge.a, edge.b), miles: edge.miles })
  }
  return out
}

function solveGreedy(nodes: number[], adj: MatchEdge[][]): MatchEdge[] {
  const inSet = new Set(nodes)
  const edges = nodes.flatMap(v => adj[v].filter(e => e.a < e.b && inSet.has(e.b)))
  edges.sort((x, y) => x.miles - y.miles)
  const used = new Set<number>()
  const out: MatchEdge[] = []
  for (const e of edges) {
    if (used.has(e.a) || used.has(e.b)) continue
    used.add(e.a); used.add(e.b)
    out.push(e)
  }
  return out
}
