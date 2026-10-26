//! Louvain community detection (modularity maximisation by local moves,
//! then aggregation, repeated until nothing moves). Deterministic: nodes
//! are visited in index order and ties go to the lowest community id, so
//! the same graph always gives the same partition.

use std::collections::BTreeMap;

const EPS: f64 = 1e-12;
const MAX_PASSES: usize = 64;
const MAX_LEVELS: usize = 32;

/// Weighted undirected graph as an adjacency list; `adj[i]` holds
/// `(neighbour, weight)` with self-loops allowed (aggregated levels).
#[derive(Debug, Clone)]
struct Level {
    adj: Vec<Vec<(usize, f64)>>,
}

impl Level {
    fn from_edges(n: usize, edges: &[(usize, usize, f64)]) -> Self {
        let mut acc: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); n];
        for &(a, b, w) in edges {
            if w <= 0.0 || a >= n || b >= n {
                continue;
            }
            *acc[a].entry(b).or_default() += w;
            if a != b {
                *acc[b].entry(a).or_default() += w;
            }
        }
        Self {
            adj: acc.into_iter().map(|m| m.into_iter().collect()).collect(),
        }
    }

    /// Node strength: a self-loop counts twice, as in the modularity formula.
    fn strength(&self, i: usize) -> f64 {
        self.adj[i]
            .iter()
            .map(|&(j, w)| if j == i { 2.0 * w } else { w })
            .sum()
    }
}

/// One round of local moves; returns the community of each node
/// (renumbered 0..k in first-seen order) and whether anything moved.
fn local_moves(level: &Level, resolution: f64) -> (Vec<usize>, bool) {
    let n = level.adj.len();
    let k: Vec<f64> = (0..n).map(|i| level.strength(i)).collect();
    let m2: f64 = k.iter().sum();
    let mut comm: Vec<usize> = (0..n).collect();
    let mut tot: Vec<f64> = k.clone();
    if m2 <= EPS {
        return (comm, false);
    }
    let mut moved_any = false;
    for _ in 0..MAX_PASSES {
        let mut moved = false;
        for i in 0..n {
            let own = comm[i];
            // weight from i into each neighbouring community (no self-loop).
            let mut links: BTreeMap<usize, f64> = BTreeMap::new();
            for &(j, w) in &level.adj[i] {
                if j != i {
                    *links.entry(comm[j]).or_default() += w;
                }
            }
            tot[own] -= k[i];
            let gain = |c: usize, w_in: f64| w_in - resolution * tot[c] * k[i] / m2;
            let mut best = own;
            let mut best_gain = gain(own, links.get(&own).copied().unwrap_or(0.0));
            for (&c, &w_in) in &links {
                let g = gain(c, w_in);
                // Strictly better only: ties keep the node where it is, or
                // (visited in id order) at the lowest-id candidate.
                if g > best_gain + EPS {
                    best = c;
                    best_gain = g;
                }
            }
            tot[best] += k[i];
            if best != own {
                comm[i] = best;
                moved = true;
                moved_any = true;
            }
        }
        if !moved {
            break;
        }
    }
    (renumber(&comm), moved_any)
}

fn renumber(comm: &[usize]) -> Vec<usize> {
    let mut map: BTreeMap<usize, usize> = BTreeMap::new();
    let mut next = 0;
    comm.iter()
        .map(|c| {
            *map.entry(*c).or_insert_with(|| {
                next += 1;
                next - 1
            })
        })
        .collect()
}

fn aggregate(level: &Level, comm: &[usize]) -> Level {
    let k = comm.iter().copied().max().map_or(0, |m| m + 1);
    let mut acc: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); k];
    for (i, row) in level.adj.iter().enumerate() {
        for &(j, w) in row {
            // Each undirected edge appears in both rows; a self-loop once.
            let (ci, cj) = (comm[i], comm[j]);
            if i == j {
                *acc[ci].entry(ci).or_default() += w;
            } else if ci == cj {
                // internal edge seen twice (i→j and j→i): half each time.
                *acc[ci].entry(ci).or_default() += w / 2.0;
            } else {
                *acc[ci].entry(cj).or_default() += w;
            }
        }
    }
    Level {
        adj: acc.into_iter().map(|m| m.into_iter().collect()).collect(),
    }
}

/// Partition nodes `0..n` into communities. Returns each node's community
/// id; ids are numbered by the lowest node index they contain.
pub(crate) fn communities(n: usize, edges: &[(usize, usize, f64)], resolution: f64) -> Vec<usize> {
    let mut level = Level::from_edges(n, edges);
    // node → community at the current top level.
    let mut membership: Vec<usize> = (0..n).collect();
    for _ in 0..MAX_LEVELS {
        let (comm, moved) = local_moves(&level, resolution);
        if !moved {
            break;
        }
        for m in membership.iter_mut() {
            *m = comm[*m];
        }
        level = aggregate(&level, &comm);
    }
    renumber(&membership)
}

/// Modularity of a partition (for tests and diagnostics).
#[cfg(test)]
pub(crate) fn modularity(n: usize, edges: &[(usize, usize, f64)], comm: &[usize]) -> f64 {
    let level = Level::from_edges(n, edges);
    let k: Vec<f64> = (0..n).map(|i| level.strength(i)).collect();
    let m2: f64 = k.iter().sum();
    let mut q = 0.0;
    for i in 0..n {
        for j in 0..n {
            if comm[i] != comm[j] {
                continue;
            }
            let a = level.adj[i]
                .iter()
                .find(|(x, _)| *x == j)
                .map_or(0.0, |(_, w)| if i == j { 2.0 * w } else { *w });
            q += a - k[i] * k[j] / m2;
        }
    }
    q / m2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clique(nodes: &[usize], w: f64, out: &mut Vec<(usize, usize, f64)>) {
        for (x, &a) in nodes.iter().enumerate() {
            for &b in &nodes[x + 1..] {
                out.push((a, b, w));
            }
        }
    }

    #[test]
    fn two_cliques_joined_by_a_bridge_split_in_two() {
        let mut e = vec![];
        clique(&[0, 1, 2, 3], 1.0, &mut e);
        clique(&[4, 5, 6, 7], 1.0, &mut e);
        e.push((3, 4, 0.2));
        let c = communities(8, &e, 1.0);
        assert_eq!(c, vec![0, 0, 0, 0, 1, 1, 1, 1]);
    }

    #[test]
    fn ring_of_cliques_finds_each_clique() {
        let mut e = vec![];
        for k in 0..6 {
            let base = k * 5;
            clique(&[base, base + 1, base + 2, base + 3, base + 4], 1.0, &mut e);
            e.push((base + 4, (base + 5) % 30, 0.1));
        }
        let c = communities(30, &e, 1.0);
        for k in 0..6 {
            let base = k * 5;
            assert!(
                (base..base + 5).all(|i| c[i] == c[base]),
                "clique {k}: {c:?}"
            );
        }
        let distinct: std::collections::BTreeSet<_> = c.iter().collect();
        assert_eq!(distinct.len(), 6);
        assert!(modularity(30, &e, &c) > 0.7);
    }

    #[test]
    fn isolated_nodes_stay_alone() {
        let c = communities(4, &[(0, 1, 1.0)], 1.0);
        assert_eq!(c[0], c[1]);
        assert_ne!(c[2], c[3]);
        assert_ne!(c[2], c[0]);
    }

    #[test]
    fn deterministic_regardless_of_edge_order() {
        let mut e = vec![];
        clique(&[0, 1, 2], 1.0, &mut e);
        clique(&[3, 4, 5], 1.0, &mut e);
        clique(&[6, 7, 8], 0.5, &mut e);
        e.push((2, 3, 0.3));
        e.push((5, 6, 0.3));
        let a = communities(9, &e, 1.0);
        let mut rev = e.clone();
        rev.reverse();
        let b = communities(9, &rev, 1.0);
        assert_eq!(a, b);
        for _ in 0..5 {
            assert_eq!(communities(9, &e, 1.0), a);
        }
    }

    #[test]
    fn empty_graph() {
        assert_eq!(communities(0, &[], 1.0), Vec::<usize>::new());
        assert_eq!(communities(3, &[], 1.0), vec![0, 1, 2]);
    }
}
