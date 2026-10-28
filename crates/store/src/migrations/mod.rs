//! Forward-only migrations, numbered and embedded at compile time. Adding a
//! migration means adding a new `NNNN_*.sql` file and a matching entry here;
//! never edit a migration that shipped.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use theodore_ports::StoreError;

use crate::{de, now_ms};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "0001_init",
        sql: include_str!("0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "0002_outbox_last_error",
        sql: include_str!("0002_outbox_last_error.sql"),
    },
];

/// How many backup copies of the database to keep around a migration run.
const KEEP_BACKUPS: usize = 3;

/// Create `schema_version` if missing, then apply every migration newer than
/// the current version, inside one transaction. `db_path` is `None` for
/// in-memory stores, which never get backed up.
pub(crate) fn migrate(conn: &mut Connection, db_path: Option<&Path>) -> Result<(), StoreError> {
    migrate_with(conn, db_path, MIGRATIONS)
}

/// Same as `migrate`, against an explicit migration list — lets tests exercise
/// multi-step upgrades and the "newer than this binary" guard without ever
/// touching the real, shipped schema.
fn migrate_with(
    conn: &mut Connection,
    db_path: Option<&Path>,
    migrations: &[Migration],
) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
    )
    .map_err(de)?;
    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .map_err(de)?;
    let target: i64 = migrations.iter().map(|m| m.version).max().unwrap_or(0);

    if current > target {
        return Err(StoreError::Migration(format!(
            "database schema is v{current}, this binary only supports up to v{target}; downgrade is not supported"
        )));
    }
    if current == target {
        return Ok(());
    }

    // Only an existing, non-empty database is worth backing up.
    if let (Some(path), true) = (db_path, current > 0) {
        backup_before_migrate(path, current)?;
    }

    let tx = conn.transaction().map_err(de)?;
    for m in migrations.iter().filter(|m| m.version > current) {
        tx.execute_batch(m.sql)
            .map_err(|e| StoreError::Migration(format!("{}: {e}", m.name)))?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![m.version, now_ms()],
        )
        .map_err(de)?;
    }
    tx.commit().map_err(de)?;
    Ok(())
}

fn backup_before_migrate(path: &Path, from_version: i64) -> Result<(), StoreError> {
    let file_name = path
        .file_name()
        .ok_or_else(|| StoreError::Migration("database path has no file name".into()))?
        .to_string_lossy()
        .to_string();
    let bak_path = path.with_file_name(format!("{file_name}.bak-{from_version}"));
    std::fs::copy(path, &bak_path)
        .map_err(|e| StoreError::Migration(format!("backup before migration failed: {e}")))?;
    prune_old_backups(path, &file_name);
    Ok(())
}

/// Best-effort: a failure to prune old backups must not block the migration.
fn prune_old_backups(path: &Path, file_name: &str) {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let prefix = format!("{file_name}.bak-");
    let mut backups: Vec<(i64, PathBuf)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(&prefix) else {
            continue;
        };
        if let Ok(v) = suffix.parse::<i64>() {
            backups.push((v, entry.path()));
        }
    }
    backups.sort_by_key(|(v, _)| *v);
    while backups.len() > KEEP_BACKUPS {
        let (_, p) = backups.remove(0);
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_versions() -> Vec<Migration> {
        vec![
            Migration {
                version: 1,
                name: "0001_init",
                sql: include_str!("0001_init.sql"),
            },
            Migration {
                version: 2,
                name: "0002_test_marker",
                sql: "CREATE TABLE test_marker (id INTEGER PRIMARY KEY);",
            },
        ]
    }

    #[test]
    fn applies_pending_migrations_in_order_and_backs_up_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theodore.db");
        let migrations = two_versions();

        let mut conn = Connection::open(&path).unwrap();
        migrate_with(&mut conn, Some(&path), &migrations[..1]).unwrap();
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);

        // Upgrading an existing (non-empty) db backs it up before migrating.
        migrate_with(&mut conn, Some(&path), &migrations).unwrap();
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 2);
        conn.execute("INSERT INTO test_marker DEFAULT VALUES", [])
            .unwrap();

        let bak = path.with_file_name(format!(
            "{}.bak-1",
            path.file_name().unwrap().to_string_lossy()
        ));
        assert!(bak.exists());
    }

    #[test]
    fn fresh_database_is_never_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theodore.db");
        let migrations = two_versions();
        let mut conn = Connection::open(&path).unwrap();
        migrate_with(&mut conn, Some(&path), &migrations).unwrap();
        let bak = path.with_file_name(format!(
            "{}.bak-0",
            path.file_name().unwrap().to_string_lossy()
        ));
        assert!(!bak.exists());
    }

    #[test]
    fn rejects_a_database_newer_than_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theodore.db");
        let migrations = two_versions();
        let mut conn = Connection::open(&path).unwrap();
        migrate_with(&mut conn, Some(&path), &migrations).unwrap(); // db ends up at v2

        let older_binary = &migrations[..1]; // only knows v1
        let err = migrate_with(&mut conn, Some(&path), older_binary).unwrap_err();
        assert!(
            matches!(err, StoreError::Migration(_)),
            "expected a Migration error, got {err:?}"
        );
    }

    #[test]
    fn keeps_only_the_last_three_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theodore.db");
        Connection::open(&path).unwrap(); // just create the file

        for from in 1..=5 {
            backup_before_migrate(&path, from).unwrap();
        }

        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let prefix = format!("{file_name}.bak-");
        let mut kept: Vec<i64> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_prefix(&prefix))
                    .and_then(|v| v.parse().ok())
            })
            .collect();
        kept.sort_unstable();
        assert_eq!(kept, vec![3, 4, 5]);
    }
}
