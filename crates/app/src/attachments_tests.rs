//! `save_attachment` / `attachment_data` against `Core` + `testkit` fakes:
//! files land under `<data dir>/attachments/<id>/<name>`, come back as a
//! `data:` URL, and nothing outside that directory is ever reachable.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use theodore_contract::SaveAttachmentRequest;

use crate::testkit::fixtures;
use crate::usecases::attachments::MAX_ATTACHMENT_BYTES;
use crate::{AppError, Core};

fn save(name: &str, mime: &str, bytes: &[u8]) -> SaveAttachmentRequest {
    SaveAttachmentRequest {
        name: name.into(),
        mime: mime.into(),
        data: STANDARD.encode(bytes),
    }
}

#[tokio::test]
async fn a_saved_file_lives_under_the_data_dir_and_reads_back() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let att = core
        .save_attachment(save("../../shot.png", "", b"\x89PNG"))
        .await
        .unwrap();
    assert_eq!(att.name, "shot.png");
    assert_eq!(att.mime, "image/png", "guessed from the extension");
    assert_eq!(att.size, 4);
    let expected = f
        .data_dir
        .path()
        .join("attachments")
        .join(&att.id)
        .join("shot.png");
    assert_eq!(att.path, expected.display().to_string());
    assert_eq!(std::fs::read(&expected).unwrap(), b"\x89PNG");

    let url = core.attachment_data(att.id.clone()).await.unwrap();
    assert_eq!(
        url,
        format!("data:image/png;base64,{}", STANDARD.encode(b"\x89PNG"))
    );
}

#[tokio::test]
async fn the_given_mime_is_kept() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let att = core
        .save_attachment(save("notes", "text/plain", b"hi"))
        .await
        .unwrap();
    assert_eq!(att.mime, "text/plain");
    assert!(
        core.attachment_data(att.id)
            .await
            .unwrap()
            .starts_with("data:text/plain;base64,")
    );
}

#[tokio::test]
async fn over_25_mb_is_refused() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let err = core
        .save_attachment(save("big.bin", "", &vec![0u8; MAX_ATTACHMENT_BYTES + 1]))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, AppError::Invalid(m) if m.contains("25 MB")),
        "{err:?}"
    );
    assert!(!f.data_dir.path().join("attachments").exists());
    // Exactly the limit is fine.
    core.save_attachment(save("ok.bin", "", &vec![0u8; MAX_ATTACHMENT_BYTES]))
        .await
        .unwrap();
}

#[tokio::test]
async fn bad_base64_is_refused() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let err = core
        .save_attachment(SaveAttachmentRequest {
            name: "a.txt".into(),
            mime: String::new(),
            data: "not base64!".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
}

#[tokio::test]
async fn only_saved_ids_are_read() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    std::fs::write(f.data_dir.path().join("config.yaml"), "secret").unwrap();
    for bad in ["..", "../config.yaml", "a/b", ""] {
        let err = core.attachment_data(bad.into()).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "{bad:?}: {err:?}");
    }
    let err = core
        .attachment_data("0b6e8a52-3c1f-4d7e-9a1b-2f3c4d5e6f70".into())
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}
