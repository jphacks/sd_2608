use super::*;
use crate::infrastructure::storage::{FileRepository, secrets::DpapiSecretStore};
use std::sync::atomic::{AtomicBool, Ordering};
pub(crate) fn id(value: &str) -> Id {
    Id::try_from(value.to_string()).unwrap()
}
fn n(value: u64) -> SafeInt {
    SafeInt::try_from(value).unwrap()
}
fn request(revision: u64, key: KeyChange) -> UpdateSettingsRequest {
    UpdateSettingsRequest {
        request_id: id("update"),
        expected_settings_revision: n(revision),
        values: SettingsInput {
            report_mode: ReportMode::Local,
            provider: Some(ProviderSettings {
                kind: ProviderKind::OpenAiCompatible,
                endpoint: "https://example.invalid/v1/chat/completions".into(),
                model: "dummy-model".into(),
            }),
            excluded_apps: vec!["private.exe".into()],
            reduced_motion: true,
            ocr_enabled: false,
        },
        key_change: key,
    }
}
#[test]
fn legacy_settings_default_ocr_off_and_the_toggle_round_trips() {
    let mut request = request(0, KeyChange::Keep);
    let mut legacy = serde_json::to_value(&request.values).unwrap();
    legacy.as_object_mut().unwrap().remove("ocrEnabled");
    assert!(
        !serde_json::from_value::<SettingsInput>(legacy)
            .unwrap()
            .ocr_enabled
    );
    let repository = Arc::new(MemoryRepository::default());
    let secrets = Arc::new(MemorySecretStore::default());
    let mut store = Persistence::open(repository.clone(), secrets.clone(), 0);
    assert!(!store.settings_view().ocr_enabled);
    request.values.ocr_enabled = true;
    store.update(&request).unwrap();
    assert!(
        Persistence::open(repository, secrets, 0)
            .settings_view()
            .ocr_enabled
    );
}
pub(crate) fn report(serial: u64, now: u64) -> Report {
    let session = id(&format!("session-{serial}"));
    Report {
        id: id(&format!("report-{serial}")),
        session_id: session.clone(),
        trigger: ReportTrigger::Yes,
        created_at: n(now),
        updated_at: n(now),
        attempt: n(1),
        status: ReportStatus::Local,
        history: HistorySnapshot {
            id: id(&format!("history-{serial}")),
            session_id: session.clone(),
            captured_at: n(now),
            range_start: n(now - 1000),
            range_end: n(now),
            ocr: None,
            segments: vec![ActivitySegment {
                id: id(&format!("segment-{serial}")),
                session_id: session,
                started_at: n(now - 1000),
                ended_at: n(now),
                app_name: "editor.exe".into(),
                masked_title: "dummy document [URL]".into(),
                window_ref: None,
            }],
        },
        content: None,
        error: None,
    }
}
struct FailingRepo {
    inner: MemoryRepository,
    fail: AtomicBool,
}
impl Repository for FailingRepo {
    fn load_settings(&self) -> StorageResult<Option<SavedSettings>> {
        self.inner.load_settings()
    }
    fn load_reports(&self) -> StorageResult<Option<SavedReports>> {
        self.inner.load_reports()
    }
    fn save_settings(&self, saved: &SavedSettings) -> StorageResult<()> {
        if self.fail.load(Ordering::Relaxed) {
            Err(StorageError::Unavailable)
        } else {
            self.inner.save_settings(saved)
        }
    }
    fn save_reports(&self, saved: &SavedReports) -> StorageResult<()> {
        if self.fail.load(Ordering::Relaxed) {
            Err(StorageError::Unavailable)
        } else {
            self.inner.save_reports(saved)
        }
    }
}
#[test]
fn settings_round_trip_revision_key_keep_replace_remove_and_provider_switch() {
    let repo = Arc::new(MemoryRepository::default());
    let secrets = Arc::new(MemorySecretStore::default());
    let mut store = Persistence::open(repo.clone(), secrets.clone(), 10_000);
    assert!(
        store
            .update(&request(
                0,
                KeyChange::Replace {
                    value: "dummy-key-one".into()
                }
            ))
            .unwrap()
            .has_api_key
    );
    let first_id = repo.load_settings().unwrap().unwrap().secret_id.unwrap();
    assert_eq!(
        store.update(&request(0, KeyChange::Keep)).unwrap_err().code,
        ErrorCode::StaleRevision
    );
    assert!(
        store
            .update(&request(1, KeyChange::Keep))
            .unwrap()
            .has_api_key
    );
    assert!(
        store
            .update(&request(
                2,
                KeyChange::Replace {
                    value: "dummy-key-two".into()
                }
            ))
            .unwrap()
            .has_api_key
    );
    assert!(secrets.read(&first_id).is_err());
    let mut changed = request(3, KeyChange::Keep);
    changed.values.provider.as_mut().unwrap().endpoint =
        "http://127.0.0.1:9999/v1/chat/completions".into();
    assert!(!store.update(&changed).unwrap().has_api_key);
    let restored = Persistence::open(repo.clone(), secrets, 10_000);
    assert_eq!(restored.settings_view(), store.settings_view());
    assert!(
        !serde_json::to_string(&repo.load_settings().unwrap())
            .unwrap()
            .contains("dummy-key")
    );
    assert!(
        !store
            .update(&request(4, KeyChange::Remove))
            .unwrap()
            .has_api_key
    );
}
#[test]
fn settings_and_secret_failures_leave_previous_revision_and_key_intact() {
    let repo = Arc::new(FailingRepo {
        inner: MemoryRepository::default(),
        fail: AtomicBool::new(false),
    });
    let secrets = Arc::new(MemorySecretStore::default());
    let mut store = Persistence::open(repo.clone(), secrets.clone(), 10_000);
    store
        .update(&request(
            0,
            KeyChange::Replace {
                value: "dummy-original".into(),
            },
        ))
        .unwrap();
    let old = store.settings_view();
    let original = repo.load_settings().unwrap().unwrap().secret_id.unwrap();
    repo.fail.store(true, Ordering::Relaxed);
    for key in [
        KeyChange::Replace {
            value: "dummy-new".into(),
        },
        KeyChange::Remove,
    ] {
        assert_eq!(
            store.update(&request(1, key)).unwrap_err().code,
            ErrorCode::StorageFailure
        );
        assert_eq!(store.settings_view(), old);
        assert_eq!(secrets.read(&original).unwrap().0, b"dummy-original");
    }
    assert_eq!(
        store
            .save_report(report(1, 10_000), 10_000)
            .unwrap_err()
            .code,
        ErrorCode::StorageFailure
    );
    repo.fail.store(false, Ordering::Relaxed);
    assert!(
        store
            .list(
                &ListReportsRequest {
                    cursor: None,
                    limit: n(20)
                },
                10_000,
                &id("runtime")
            )
            .unwrap()
            .items
            .is_empty()
    );
}
#[test]
fn validates_urls_keys_and_exclusions_without_echoing_input() {
    let mut store = Persistence::default();
    for endpoint in [
        "http://example.test/api",
        "https://user:dummy@host.test",
        "https://host.test?key=dummy",
        "file:///test",
        "https://host.test/#key",
        "bad",
    ] {
        let mut input = request(0, KeyChange::Keep);
        input.values.provider.as_mut().unwrap().endpoint = endpoint.into();
        let error = store.update(&input).unwrap_err();
        assert_eq!(error.code, ErrorCode::Validation);
        assert!(!error.message.contains(endpoint));
    }
    for endpoint in [
        "http://localhost:9999/v1/chat/completions",
        "http://[::1]:9999/api",
        "https://api.example.test",
    ] {
        let mut values = request(0, KeyChange::Keep).values;
        values.provider.as_mut().unwrap().endpoint = endpoint.into();
        assert!(validate_settings(&values).is_ok());
    }
    for key in ["", "dummy\nkey", "has space"] {
        assert_eq!(
            store
                .update(&request(0, KeyChange::Replace { value: key.into() }))
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }
    let mut input = request(0, KeyChange::Keep);
    input.values.excluded_apps = vec!["C:\\private.exe".into()];
    assert!(store.update(&input).is_err());
}
#[test]
fn cards_are_retained_paged_read_and_cursors_invalidated_after_changes() {
    let mut store = Persistence::default();
    let now = 1_000_000_000;
    store
        .save_report(report(100, now - REPORT_RETENTION_MS - 1), now)
        .unwrap();
    for i in 1..=25 {
        store.save_report(report(i, now - 100 + i), now).unwrap();
    }
    let request = ListReportsRequest {
        cursor: None,
        limit: n(7),
    };
    let page = store.list(&request, now, &id("runtime")).unwrap();
    assert_eq!(page.items[0].id, id("report-25"));
    assert_eq!(page.items.len(), 7);
    let second = store
        .list(
            &ListReportsRequest {
                cursor: page.next_cursor.clone(),
                limit: n(20),
            },
            now,
            &id("runtime"),
        )
        .unwrap();
    assert_eq!(second.items.len(), 13);
    assert!(second.next_cursor.is_none());
    assert_eq!(
        store.get(&id("report-1"), now).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        store.get(&id("report-25"), now).unwrap(),
        report(25, now - 75)
    );
    store.clear().unwrap();
    assert_eq!(
        store
            .list(
                &ListReportsRequest {
                    cursor: page.next_cursor,
                    limit: n(7)
                },
                now,
                &id("runtime")
            )
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
}
#[test]
fn disk_round_trip_expiry_and_clear_preserve_settings_and_secrets() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_path_buf();
    let repo = Arc::new(FileRepository::new(root.clone()));
    let secrets = Arc::new(MemorySecretStore::default());
    let mut store = Persistence::open(repo.clone(), secrets.clone(), 1_000_000_000);
    let settings = store.update(&request(0, KeyChange::Keep)).unwrap();
    store
        .save_report(report(1, 1_000_000_000), 1_000_000_000)
        .unwrap();
    drop(store);
    let mut restored = Persistence::open(repo.clone(), secrets, 1_000_000_001);
    assert_eq!(restored.settings_view(), settings);
    assert_eq!(
        restored.get(&id("report-1"), 1_000_000_001).unwrap().status,
        ReportStatus::Local
    );
    assert!(
        restored
            .get(&id("report-1"), 1_000_000_001 + REPORT_RETENTION_MS)
            .is_err()
    );
    restored.clear().unwrap();
    assert!(repo.load_reports().unwrap().unwrap().reports.is_empty());
    assert_eq!(repo.load_settings().unwrap().unwrap().revision, n(1));
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
}
#[test]
fn corrupt_unknown_version_or_invalid_reports_are_preserved_and_block_writes() {
    for name in ["settings.json", "reports.json"] {
        for content in [
            b"broken".as_slice(),
            b"{\"schemaVersion\":999,\"reports\":[]}".as_slice(),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(name);
            std::fs::write(&path, content).unwrap();
            let mut store = Persistence::open(
                Arc::new(FileRepository::new(temp.path().into())),
                Arc::new(MemorySecretStore::default()),
                10_000,
            );
            assert_eq!(store.warning().unwrap().code, ErrorCode::StorageFailure);
            if name == "settings.json" {
                assert!(store.update(&request(0, KeyChange::Keep)).is_err());
            } else {
                assert!(store.clear().is_err());
            }
            assert_eq!(std::fs::read(path).unwrap(), content);
        }
    }
    let repo = Arc::new(MemoryRepository::default());
    let mut bad = report(1, 10_000);
    bad.history.segments[0].session_id = id("other");
    repo.save_reports(&SavedReports {
        schema_version: 1,
        reports: vec![bad],
    })
    .unwrap();
    assert!(
        Persistence::open(repo, Arc::new(MemorySecretStore::default()), 10_000)
            .warning()
            .is_some()
    );
}
#[test]
fn file_save_failure_preserves_original_and_reports_storage_error() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("not-a-directory");
    std::fs::write(&path, b"original").unwrap();
    let repo = FileRepository::new(path.clone());
    assert_eq!(
        repo.save_reports(&SavedReports {
            schema_version: 1,
            reports: vec![]
        })
        .unwrap_err(),
        StorageError::Unavailable
    );
    assert_eq!(std::fs::read(path).unwrap(), b"original");
}
#[cfg(windows)]
#[test]
fn dpapi_dummy_key_is_encrypted_round_trips_and_rejects_path_traversal() {
    let temp = tempfile::tempdir().unwrap();
    let store = DpapiSecretStore::new(temp.path().into());
    let dummy = "dummy-api-key-for-test-only";
    let reference = store.put(dummy).unwrap();
    assert_eq!(store.read(&reference).unwrap().0, dummy.as_bytes());
    let raw = std::fs::read(
        temp.path()
            .join("secrets")
            .join(format!("{}.bin", reference.as_str())),
    )
    .unwrap();
    assert!(
        !raw.windows(dummy.len())
            .any(|bytes| bytes == dummy.as_bytes())
    );
    assert!(store.read(&id("../../outside")).is_err());
    store.remove(&reference).unwrap();
    assert!(store.read(&reference).is_err());
}
#[cfg(windows)]
#[test]
fn locked_settings_file_keeps_original_json_and_secret_when_replace_fails() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let repo = Arc::new(FileRepository::new(temp.path().into()));
    let secrets = Arc::new(DpapiSecretStore::new(temp.path().into()));
    let mut store = Persistence::open(repo.clone(), secrets.clone(), 10_000);
    let first = store
        .update(&request(
            0,
            KeyChange::Replace {
                value: "dummy-locked-original".into(),
            },
        ))
        .unwrap();
    let file = temp.path().join("settings.json");
    let original = std::fs::read(&file).unwrap();
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&file)
        .unwrap();
    assert_eq!(
        store
            .update(&request(
                1,
                KeyChange::Replace {
                    value: "dummy-replacement".into()
                }
            ))
            .unwrap_err()
            .code,
        ErrorCode::StorageFailure
    );
    assert_eq!(store.settings_view(), first);
    drop(locked);
    assert_eq!(std::fs::read(file).unwrap(), original);
    assert_eq!(
        std::fs::read_dir(temp.path().join("secrets"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(
        secrets
            .read(&repo.load_settings().unwrap().unwrap().secret_id.unwrap())
            .unwrap()
            .0,
        b"dummy-locked-original"
    );
}
#[test]
fn failed_secret_write_does_not_commit_settings_and_missing_key_can_be_replaced() {
    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn put(&self, _: &str) -> StorageResult<Id> {
            Err(StorageError::Unavailable)
        }
        fn read(&self, _: &Id) -> StorageResult<Secret> {
            Err(StorageError::Unavailable)
        }
        fn remove(&self, _: &Id) -> StorageResult<()> {
            Ok(())
        }
    }
    let repo = Arc::new(MemoryRepository::default());
    let mut store = Persistence::open(repo.clone(), Arc::new(NoSecrets), 10_000);
    assert_eq!(
        store
            .update(&request(
                0,
                KeyChange::Replace {
                    value: "dummy-secret".into()
                }
            ))
            .unwrap_err()
            .code,
        ErrorCode::StorageFailure
    );
    assert!(repo.load_settings().unwrap().is_none());
    repo.save_settings(&SavedSettings {
        schema_version: 1,
        revision: n(3),
        values: request(0, KeyChange::Keep).values,
        secret_id: Some(id("key-missing")),
    })
    .unwrap();
    let mut store = Persistence::open(repo, Arc::new(MemorySecretStore::default()), 10_000);
    assert!(store.warning().is_some());
    assert!(!store.settings_view().has_api_key);
    assert!(
        store
            .update(&request(
                3,
                KeyChange::Replace {
                    value: "dummy-recovered".into()
                }
            ))
            .unwrap()
            .has_api_key
    );
    assert!(store.warning().is_none());
}
