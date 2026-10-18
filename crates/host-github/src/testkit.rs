//! Adapter-agnostic assertions any `HostAdapter` should satisfy. Intended
//! for reuse once other hosts land (plan §6.9: "one contract test suite, run
//! against every adapter on recorded HTTP fixtures").
//!
//! Each fn panics (via `assert!`/`assert_eq!`) on a violation, like a normal
//! test body — call them from inside a `#[tokio::test]` against an adapter
//! wired to wiremock (or, opt-in, a live host).

use theodore_domain::PrRef;
use theodore_ports::{Fetched, HostAdapter, HostResult};

/// `capabilities()` must be pure: same adapter, same answer, no I/O.
pub fn assert_capabilities_contract(adapter: &dyn HostAdapter) {
    assert_eq!(
        adapter.capabilities(),
        adapter.capabilities(),
        "capabilities() must be pure"
    );
}

/// A first `get_pr` (no prior etag) must return `Modified` and describe the
/// PR asked for; re-fetching with the etag it handed back must short-circuit
/// to `NotModified`.
pub async fn assert_get_pr_contract(adapter: &dyn HostAdapter, pr: &PrRef) -> HostResult<()> {
    let Fetched::Modified { etag, value } = adapter.get_pr(pr, None).await? else {
        panic!("a fetch with no prior etag must never return NotModified");
    };
    assert_eq!(
        value.summary.pr.number, pr.number,
        "PrDetail must describe the PR that was asked for"
    );

    if let Some(etag) = etag {
        let second = adapter.get_pr(pr, Some(&etag)).await?;
        assert!(
            matches!(second, Fetched::NotModified),
            "re-fetching with the returned etag must short-circuit"
        );
    }
    Ok(())
}
