/**
 * Pair areas onto trucks: as many pairs as possible, then the shortest hops.
 *
 * This is maximum-cardinality, minimum-weight matching on a general graph. The
 * textbook answer is Edmonds' blossom algorithm; we do not need it. The graph
 * only has edges between areas within one truck-hop of each other, so it falls
 * apart into small regional clusters, and each cluster is solved exactly with a
 * memoised search over "who is still unpaired". Ordering a cluster's nodes by
 * breadth-first search keeps that state small.
 *
 * The search state is a BigInt bitmask, so there is no size cutoff: a cluster
 * of any size is solved exactly. Only if the search itself grows past
 * MEMO_LIMIT states (a dense cluster with a very large hop limit) does it fall
 * back to greedy shortest-hop-first, and that is reported, so a sub-optimal
 * answer is never silent.
 */

export type MatchEdge = { a: number; b: number; miles: number }

export type MatchResult = {
  pairs: MatchEdge[]
  /** Clusters solved greedily because the exact search grew too large. */
  greedyClusters: number
}

const MEMO_LIMIT = 2_000_000
const PAIR_VALUE = 1e7 // one more pair always beats any saving in miles

export function maxPairing(n: number, edges: MatchEdge[]): MatchResult {
  const adj: MatchEdge[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    adj[e.a].push(e)
    adj[e.b].push({ a: e.b, b: e.a, miles: e.miles })
  }

  // Connected components.
  const comp = new Array<number>(n).fill(-1)
  const components: number[][] = []
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue
    const order: number[] = []
    const queue = [s]
    comp[s] = components.length
    while (queue.length) {
      const v = queue.shift()!
      order.push(v)
      for (const e of adj[v]) if (comp[e.b] === -1) { comp[e.b] = components.length; queue.push(e.b) }
    }
    components.push(order)
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

  const memo = new Map<string, { value: number; pick: number }>()
  let aborted = false
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
    if (memo.size > MEMO_LIMIT) { aborted = true; return 0 }

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
