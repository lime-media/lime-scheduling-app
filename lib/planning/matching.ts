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
 * The search state is a BigInt bitmask, so there is no size cutoff. The work
 * is bounded by work, not by the clock: the search stops at MEMO_LIMIT states
 * or STEP_LIMIT calls, whichever comes first. A wall-clock budget would let the
 * same order get a different answer on a busier server — at quote time and
 * again at booking — so the bound is deterministic. (A static k × 2^bandwidth precheck was
 * tried and removed: it is a worst-case bound, far above the states a real
 * map cluster reaches, so it rejected clusters that solved in milliseconds.)
 *
 * When a cluster is too big for the exact search, the fallback still
 * guarantees the fewest trucks. Edmonds' blossom algorithm finds a
 * maximum-cardinality matching, seeded from shortest-hop-first so the
 * augmentations start from short hops. A pair-swap pass then shortens hops
 * further. Only the total hop miles can then be above optimal, never the truck
 * count. Such clusters are counted in greedyClusters and surfaced as a warning.
 */

export type MatchEdge = { a: number; b: number; miles: number }

export type MatchResult = {
  pairs: MatchEdge[]
  /**
   * Clusters too big for the exact search. Their truck count is still optimal
   * (maximum cardinality); only their hop miles may be above optimal.
   */
  greedyClusters: number
}

const MEMO_LIMIT = 500_000
const STEP_LIMIT = 3_000_000
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
    else { greedyClusters++; pairs.push(...solveLarge(nodes, adj)) }
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
  let steps = 0
  const bit = (n: number) => BigInt(1) << BigInt(n)
  const keyOf = (i: number, taken: bigint) => `${i}:${(taken >> BigInt(i + 1)).toString(36)}`

  // State: position i, plus which later nodes are already paired (bitmask).
  const solve = (i: number, taken: bigint): number => {
    if (aborted) return 0
    if (++steps > STEP_LIMIT) { aborted = true; return 0 }
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

/**
 * Fallback for clusters too big to search exactly: maximum cardinality
 * (Edmonds' blossom algorithm) seeded from shortest-hop-first, then pair swaps
 * that shorten total hop miles without losing a pair.
 */
export function solveLarge(nodes: number[], adj: MatchEdge[][]): MatchEdge[] {
  const k = nodes.length
  const local = new Map(nodes.map((v, i) => [v, i]))
  const g: number[][] = nodes.map(v => adj[v].map(e => local.get(e.b)!))
  const miles = new Map<string, number>()
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
  nodes.forEach((v, i) => adj[v].forEach(e => miles.set(key(i, local.get(e.b)!), e.miles)))

  // Seed: shortest hop first.
  const match = new Array<number>(k).fill(-1)
  const edges = [...miles].map(([kk, m]) => { const [a, b] = kk.split('-').map(Number); return { a, b, m } }).sort((x, y) => x.m - y.m)
  for (const e of edges) if (match[e.a] === -1 && match[e.b] === -1) { match[e.a] = e.b; match[e.b] = e.a }

  // Edmonds: augment from every unmatched node until none can grow.
  const p = new Array<number>(k)
  const base = new Array<number>(k)
  const used = new Array<boolean>(k)
  const blossom = new Array<boolean>(k)
  const lca = (a: number, b: number): number => {
    const seen = new Array<boolean>(k).fill(false)
    for (;;) { a = base[a]; seen[a] = true; if (match[a] === -1) break; a = p[match[a]] }
    for (;;) { b = base[b]; if (seen[b]) return b; b = p[match[b]] }
  }
  const markPath = (v: number, b: number, child: number) => {
    while (base[v] !== b) {
      blossom[base[v]] = blossom[base[match[v]]] = true
      p[v] = child
      child = match[v]
      v = p[match[v]]
    }
  }
  const findPath = (root: number): number => {
    used.fill(false); p.fill(-1)
    for (let i = 0; i < k; i++) base[i] = i
    used[root] = true
    const q = [root]
    for (let h = 0; h < q.length; h++) {
      const v = q[h]
      for (const to of g[v]) {
        if (base[v] === base[to] || match[v] === to) continue
        if (to === root || (match[to] !== -1 && p[match[to]] !== -1)) {
          const cur = lca(v, to)
          blossom.fill(false)
          markPath(v, cur, to)
          markPath(to, cur, v)
          for (let i = 0; i < k; i++) {
            if (blossom[base[i]]) {
              base[i] = cur
              if (!used[i]) { used[i] = true; q.push(i) }
            }
          }
        } else if (p[to] === -1) {
          p[to] = v
          if (match[to] === -1) return to
          used[match[to]] = true
          q.push(match[to])
        }
      }
    }
    return -1
  }
  for (let v = 0; v < k; v++) {
    if (match[v] !== -1) continue
    let end = findPath(v)
    while (end !== -1) {
      const pv = p[end]
      const next = match[pv]
      match[end] = pv
      match[pv] = end
      end = next
    }
  }

  // Shorten hops: swap partners between two pairs when both new hops exist
  // and the total is shorter. The pair count never changes.
  const hop = (a: number, b: number) => miles.get(key(a, b))
  for (let pass = 0, improved = true; improved && pass < 50; pass++) {
    improved = false
    const pairs: [number, number][] = []
    for (let i = 0; i < k; i++) if (match[i] > i) pairs.push([i, match[i]])
    for (let x = 0; x < pairs.length; x++) {
      for (let y = x + 1; y < pairs.length; y++) {
        const [a, b] = pairs[x]
        const [c, d] = pairs[y]
        if (match[a] !== b || match[c] !== d) continue
        const now = hop(a, b)! + hop(c, d)!
        for (const [u1, v1, u2, v2] of [[a, c, b, d], [a, d, b, c]]) {
          const h1 = hop(u1, v1)
          const h2 = hop(u2, v2)
          if (h1 !== undefined && h2 !== undefined && h1 + h2 < now - 1e-9) {
            match[u1] = v1; match[v1] = u1; match[u2] = v2; match[v2] = u2
            improved = true
            break
          }
        }
      }
    }
  }

  const out: MatchEdge[] = []
  for (let i = 0; i < k; i++) {
    if (match[i] > i) {
      const a = nodes[i]
      const b = nodes[match[i]]
      out.push({ a: Math.min(a, b), b: Math.max(a, b), miles: hop(i, match[i])! })
    }
  }
  return out
}
