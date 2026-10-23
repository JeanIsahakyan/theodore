//! `spaces.ports`: N free TCP ports per space, reserved for its life.
//! The OS picks each (bind `127.0.0.1:0`); the listener is closed at once so
//! the space's own server can bind it. Ports another live space holds are
//! skipped, so two spaces never share one.

use std::collections::HashSet;
use std::net::TcpListener;

/// Attempts per port before giving up (a port the OS hands out twice in a
/// row, or one another space holds).
const TRIES: usize = 64;

pub fn allocate(n: u16, taken: &HashSet<u16>) -> std::io::Result<Vec<u16>> {
    let mut out: Vec<u16> = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let mut found = None;
        for _ in 0..TRIES {
            let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
            if !taken.contains(&port) && !out.contains(&port) {
                found = Some(port);
                break;
            }
        }
        out.push(found.ok_or_else(|| std::io::Error::other("no free port found"))?);
    }
    Ok(out)
}

/// Whether `port` can be bound on localhost right now.
pub fn is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_are_free_and_unique() {
        let ports = allocate(5, &HashSet::new()).unwrap();
        assert_eq!(ports.len(), 5);
        let set: HashSet<u16> = ports.iter().copied().collect();
        assert_eq!(set.len(), 5, "{ports:?}");
        assert!(ports.iter().all(|p| is_free(*p)), "{ports:?}");
    }

    #[test]
    fn taken_ports_are_skipped() {
        let first = allocate(3, &HashSet::new()).unwrap();
        let taken: HashSet<u16> = first.iter().copied().collect();
        let second = allocate(3, &taken).unwrap();
        assert!(second.iter().all(|p| !taken.contains(p)));
    }

    #[test]
    fn zero_is_none() {
        assert!(allocate(0, &HashSet::new()).unwrap().is_empty());
    }
}
