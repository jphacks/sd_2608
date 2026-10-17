use crate::ipc::dto::Id;
use crate::ports::storage::*;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
pub mod secrets;

pub struct FileRepository {
    root: PathBuf,
}
impl FileRepository {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn load<T: DeserializeOwned>(&self, name: &str) -> StorageResult<Option<T>> {
        let mut file = match fs::File::open(self.root.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(StorageError::Unavailable),
        };
        let mut data = Vec::new();
        Read::by_ref(&mut file)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| StorageError::Unavailable)?;
        if data.len() > 16 * 1024 * 1024 {
            return Err(StorageError::InvalidData);
        }
        serde_json::from_slice(&data)
            .map(Some)
            .map_err(|_| StorageError::InvalidData)
    }
    fn save<T: Serialize>(&self, name: &str, value: &T) -> StorageResult<()> {
        let data = serde_json::to_vec(value).map_err(|_| StorageError::InvalidData)?;
        atomic_write(&self.root, name, &data)
    }
}
impl Repository for FileRepository {
    fn load_settings(&self) -> StorageResult<Option<SavedSettings>> {
        self.load("settings.json")
    }
    fn save_settings(&self, value: &SavedSettings) -> StorageResult<()> {
        self.save("settings.json", value)
    }
    fn load_reports(&self) -> StorageResult<Option<SavedReports>> {
        self.load("reports.json")
    }
    fn save_reports(&self, value: &SavedReports) -> StorageResult<()> {
        self.save("reports.json", value)
    }
}
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn unique_name() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}
pub(super) fn atomic_write(root: &Path, name: &str, data: &[u8]) -> StorageResult<()> {
    fs::create_dir_all(root).map_err(|_| StorageError::Unavailable)?;
    let temp = root.join(format!(".{}.tmp", unique_name()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| StorageError::Unavailable)?;
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|_| StorageError::Unavailable)?;
        drop(file);
        replace(&temp, &root.join(name))
    })();
    let _ = fs::remove_file(&temp);
    result
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> StorageResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| StorageError::Unavailable)
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> StorageResult<()> {
    fs::rename(from, to).map_err(|_| StorageError::Unavailable)
}

/// テスト・明示的なインメモリー起動用。通常アプリは FileRepository / DpapiSecretStore。
#[derive(Default)]
pub struct MemoryRepository {
    settings: Mutex<Option<SavedSettings>>,
    reports: Mutex<Option<SavedReports>>,
}
impl Repository for MemoryRepository {
    fn load_settings(&self) -> StorageResult<Option<SavedSettings>> {
        Ok(self
            .settings
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .clone())
    }
    fn save_settings(&self, value: &SavedSettings) -> StorageResult<()> {
        *self
            .settings
            .lock()
            .map_err(|_| StorageError::Unavailable)? = Some(value.clone());
        Ok(())
    }
    fn load_reports(&self) -> StorageResult<Option<SavedReports>> {
        Ok(self
            .reports
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .clone())
    }
    fn save_reports(&self, value: &SavedReports) -> StorageResult<()> {
        *self.reports.lock().map_err(|_| StorageError::Unavailable)? = Some(value.clone());
        Ok(())
    }
}
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, Secret>>,
}
impl SecretStore for MemorySecretStore {
    fn put(&self, value: &str) -> StorageResult<Id> {
        let id = Id::try_from(format!("key-{}", unique_name()))
            .map_err(|_| StorageError::Unavailable)?;
        self.values
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .insert(id.as_str().into(), Secret(value.as_bytes().to_vec()));
        Ok(id)
    }
    fn read(&self, id: &Id) -> StorageResult<Secret> {
        self.values
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .get(id.as_str())
            .map(|secret| Secret(secret.0.clone()))
            .ok_or(StorageError::Unavailable)
    }
    fn remove(&self, id: &Id) -> StorageResult<()> {
        self.values
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .remove(id.as_str());
        Ok(())
    }
}
