//! 保存先・暗号化を Application から差し替える。エラーにパス・内容を含めない。
use crate::ipc::dto::{Id, Report, SafeInt, SettingsInput};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageError {
    Unavailable,
    InvalidData,
}
pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedSettings {
    pub schema_version: u32,
    pub revision: SafeInt,
    pub values: SettingsInput,
    #[serde(deserialize_with = "required_secret_id")]
    pub secret_id: Option<Id>,
}
fn required_secret_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Id>, D::Error> {
    Option::<Id>::deserialize(deserializer)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedReports {
    pub schema_version: u32,
    pub reports: Vec<Report>,
}
pub trait Repository: Send + Sync {
    fn load_settings(&self) -> StorageResult<Option<SavedSettings>>;
    fn save_settings(&self, settings: &SavedSettings) -> StorageResult<()>;
    fn load_reports(&self) -> StorageResult<Option<SavedReports>>;
    fn save_reports(&self, reports: &SavedReports) -> StorageResult<()>;
}
/// キーの文字列は一時的にだけ所有し Debug へ出さない。
pub struct Secret(pub Vec<u8>);
impl Drop for Secret {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}
pub trait SecretStore: Send + Sync {
    /// 新しい名前で保存してから設定の参照を切り替える。既存キーを上書きしない。
    fn put(&self, value: &str) -> StorageResult<Id>;
    fn read(&self, id: &Id) -> StorageResult<Secret>;
    fn remove(&self, id: &Id) -> StorageResult<()>;
}
