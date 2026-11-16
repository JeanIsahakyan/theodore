//! Signals to a process or a process group, by syscall.
//!
//! The `kill` binary reads a negative pid differently per platform: BSD
//! `kill -KILL -1234` signals group 1234, procps on Linux parses `-1234` as
//! an option. A misread group kill took the test runner's own group down on
//! Linux CI. Here the target is never the caller's own group, nor 0 or 1.

use std::io;

use nix::sys::signal::{self, Signal as NixSignal};
use nix::unistd::{Pid, getpgrp};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
    Hup,
}

impl Signal {
    fn nix(self) -> NixSignal {
        match self {
            Signal::Term => NixSignal::SIGTERM,
            Signal::Kill => NixSignal::SIGKILL,
            Signal::Hup => NixSignal::SIGHUP,
        }
    }

    /// `"-TERM"` / `"TERM"` and friends.
    pub fn parse(s: &str) -> Option<Signal> {
        match s.trim_start_matches('-') {
            "TERM" => Some(Signal::Term),
            "KILL" => Some(Signal::Kill),
            "HUP" => Some(Signal::Hup),
            _ => None,
        }
    }
}

fn invalid(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, why.to_string())
}

fn target(id: u32) -> io::Result<Pid> {
    let id = i32::try_from(id).map_err(|_| invalid("pid out of range"))?;
    if id <= 1 {
        return Err(invalid("refusing to signal pid 0 or 1"));
    }
    Ok(Pid::from_raw(id))
}

/// Signals every process in group `pgid`. Refuses the caller's own group.
pub fn signal_group(pgid: u32, signal: Signal) -> io::Result<()> {
    let pgid = target(pgid)?;
    if pgid == getpgrp() {
        return Err(invalid("refusing to signal our own process group"));
    }
    signal::killpg(pgid, signal.nix()).map_err(io::Error::from)
}

/// Signals process `pid` alone. Refuses the caller itself.
pub fn signal_process(pid: u32, signal: Signal) -> io::Result<()> {
    if pid == std::process::id() {
        return Err(invalid("refusing to signal ourselves"));
    }
    signal::kill(target(pid)?, signal.nix()).map_err(io::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_the_whole_system_nor_our_own_group() {
        assert!(signal_group(0, Signal::Term).is_err());
        assert!(signal_group(1, Signal::Term).is_err());
        assert!(signal_process(1, Signal::Term).is_err());
        assert!(signal_process(std::process::id(), Signal::Term).is_err());
        let own = getpgrp().as_raw() as u32;
        assert!(signal_group(own, Signal::Kill).is_err(), "still alive");
    }

    #[test]
    fn a_group_of_our_own_child_is_signalled() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        signal_group(child.id(), Signal::Kill).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
    }

    #[test]
    fn signal_names_parse_with_or_without_the_dash() {
        assert_eq!(Signal::parse("-TERM"), Some(Signal::Term));
        assert_eq!(Signal::parse("KILL"), Some(Signal::Kill));
        assert_eq!(Signal::parse("-0"), None);
    }
}
