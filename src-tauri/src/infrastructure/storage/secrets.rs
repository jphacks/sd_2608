//! Windows ユーザーに結び付いた DPAPI。通常 JSON には参照 ID だけを保存する。
use super::{atomic_write, unique_name};
use crate::{ipc::dto::Id, ports::storage::*};
use std::{fs, path::PathBuf};

pub struct DpapiSecretStore {
    root: PathBuf,
}
impl DpapiSecretStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: root.join("secrets"),
        }
    }
    fn path(&self, id: &Id) -> StorageResult<PathBuf> {
        let name = id.as_str();
        if !name.starts_with("key-")
            || name.len() > 180
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(StorageError::InvalidData);
        }
        Ok(self.root.join(format!("{name}.bin")))
    }
}
impl SecretStore for DpapiSecretStore {
    fn put(&self, value: &str) -> StorageResult<Id> {
        let encrypted = transform(value.as_bytes(), true)?;
        let id = Id::try_from(format!("key-{}", unique_name()))
            .map_err(|_| StorageError::Unavailable)?;
        atomic_write(&self.root, &format!("{}.bin", id.as_str()), &encrypted)?;
        Ok(id)
    }
    fn read(&self, id: &Id) -> StorageResult<Secret> {
        let path = self.path(id)?;
        let file = fs::File::open(path).map_err(|_| StorageError::Unavailable)?;
        use std::io::Read;
        let mut data = Vec::new();
        file.take(65_537)
            .read_to_end(&mut data)
            .map_err(|_| StorageError::Unavailable)?;
        if data.len() > 65_536 {
            return Err(StorageError::InvalidData);
        }
        transform(&data, false).map(Secret)
    }
    fn remove(&self, id: &Id) -> StorageResult<()> {
        match fs::remove_file(self.path(id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(StorageError::Unavailable),
        }
    }
}
#[cfg(windows)]
fn transform(bytes: &[u8], encrypt: bool) -> StorageResult<Vec<u8>> {
    use windows::{
        Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
            },
        },
        core::PCWSTR,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| StorageError::InvalidData)?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: 入力は呼出中有効。DPAPI が確保した出力をコピーし、消去して LocalFree する。
    unsafe {
        let result = if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        result.map_err(|_| StorageError::Unavailable)?;
        let data = if output.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        for i in 0..output.cbData as usize {
            std::ptr::write_volatile(output.pbData.add(i), 0);
        }
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(data)
    }
}
#[cfg(not(windows))]
fn transform(_: &[u8], _: bool) -> StorageResult<Vec<u8>> {
    Err(StorageError::Unavailable)
}
