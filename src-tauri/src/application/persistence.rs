//! 設定と完成済みカードの保存規則。監視・センサー・ジョブ状態は保存しない。
use crate::{
    infrastructure::storage::{MemoryRepository, MemorySecretStore},
    ipc::dto::*,
    ports::storage::*,
};
use std::{collections::HashSet, sync::Arc};
pub const REPORT_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
pub const REPORT_LIMIT: usize = 20;

pub fn storage_error() -> ApiError {
    ApiError::new(
        ErrorCode::StorageFailure,
        "保存データを読み書きできません。元ファイルを保全して保存先を確認してください。",
    )
}
fn valid_text(value: &str, max: usize, empty: bool) -> bool {
    (empty || !value.trim().is_empty())
        && value.chars().count() <= max
        && !value.chars().any(char::is_control)
}
fn valid_paragraph(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
}
pub fn validate_settings(values: &SettingsInput) -> Result<(), ApiError> {
    if values.excluded_apps.len() > 100
        || values.excluded_apps.iter().any(|app| {
            !valid_text(app, 200, false) || app != app.trim() || app.contains(['/', '\\'])
        })
    {
        return Err(ApiError::validation());
    }
    if values.report_mode == ReportMode::Ai && values.provider.is_none() {
        return Err(ApiError::validation());
    }
    if let Some(provider) = &values.provider {
        crate::ports::report_provider::validate_provider(provider)?;
    }
    Ok(())
}
fn validate_report(report: &Report) -> bool {
    let history = &report.history;
    if report.created_at > report.updated_at
        || report.attempt.get() == 0
        || history.session_id != report.session_id
        || history.range_start > history.range_end
        || history.range_end > history.captured_at
        || history.range_end.get() - history.range_start.get()
            > crate::domain::history::RETENTION_MS
        || history.segments.len() > 600
    {
        return false;
    }
    if match report.status {
        ReportStatus::Ready => report.content.is_none() || report.error.is_some(),
        ReportStatus::Local => report.error.is_some(),
        ReportStatus::Failed => report.content.is_some() || report.error.is_none(),
    } {
        return false;
    }
    if report.content.as_ref().is_some_and(|content| {
        !valid_paragraph(&content.summary, 4000)
            || content.observed_facts.len() > 20
            || content
                .observed_facts
                .iter()
                .any(|fact| !valid_paragraph(fact, 1000))
            || content
                .next_action
                .as_ref()
                .is_some_and(|next| !valid_paragraph(next, 1000))
    }) {
        return false;
    }
    if report
        .error
        .as_ref()
        .is_some_and(|error| !valid_text(&error.message, 1000, false))
    {
        return false;
    }
    if let Some(ocr) = &history.ocr {
        if ocr.windows.len() > 128
            || ocr
                .windows
                .iter()
                .map(|w| w.text.chars().count())
                .sum::<usize>()
                > crate::application::ocr_context::MAX_OCR_CHARS
            || ocr.windows.iter().any(|w| {
                !valid_text(&w.app_name, 200, true)
                    || !valid_text(&w.masked_title, 200, true)
                    || !valid_paragraph(&w.text, 2000)
            })
        {
            return false;
        }
    }
    let mut end = history.range_start;
    let mut ids = HashSet::new();
    for segment in &history.segments {
        if segment.session_id != report.session_id
            || segment.started_at < end
            || segment.started_at >= segment.ended_at
            || segment.ended_at > history.range_end
            || !ids.insert(segment.id.as_str())
            || !valid_text(&segment.app_name, 200, true)
            || !valid_text(&segment.masked_title, 200, true)
        {
            return false;
        }
        end = segment.ended_at;
    }
    true
}
pub struct Persistence {
    repository: Arc<dyn Repository>,
    secrets: Arc<dyn SecretStore>,
    settings: SavedSettings,
    reports: Vec<Report>,
    volatile_reports: Vec<Report>,
    settings_blocked: bool,
    reports_blocked: bool,
    secret_warning: bool,
    cleanup_warning: bool,
    epoch: u64,
}
impl Default for Persistence {
    fn default() -> Self {
        Self::open(
            Arc::new(MemoryRepository::default()),
            Arc::new(MemorySecretStore::default()),
            0,
        )
    }
}
impl Persistence {
    pub fn open(repository: Arc<dyn Repository>, secrets: Arc<dyn SecretStore>, now: u64) -> Self {
        let initial =
            AppSnapshot::initial(Id::try_from("storage".to_string()).unwrap(), SafeInt::ZERO)
                .settings;
        let mut store = Self {
            repository,
            secrets,
            settings: SavedSettings {
                schema_version: 1,
                revision: SafeInt::ZERO,
                values: SettingsInput {
                    report_mode: initial.report_mode,
                    provider: None,
                    excluded_apps: vec![],
                    reduced_motion: false,
                    ocr_enabled: false,
                    notification_sound: initial.notification_sound,
                },
                secret_id: None,
            },
            reports: vec![],
            volatile_reports: vec![],
            settings_blocked: false,
            reports_blocked: false,
            secret_warning: false,
            cleanup_warning: false,
            epoch: 0,
        };
        match store.repository.load_settings() {
            Ok(Some(saved))
                if saved.schema_version == 1 && validate_settings(&saved.values).is_ok() =>
            {
                store.settings = saved;
                if let Some(id) = &store.settings.secret_id {
                    store.secret_warning = store
                        .secrets
                        .read(id)
                        .map_or(true, |secret| !valid_key(&secret.0));
                }
            }
            Ok(None) => {}
            _ => store.settings_blocked = true,
        }
        match store.repository.load_reports() {
            Ok(Some(saved))
                if saved.schema_version == 1
                    && saved.reports.len() <= 1000
                    && saved.reports.iter().all(validate_report)
                    && unique_reports(&saved.reports) =>
            {
                store.reports = saved.reports;
                let before = store.reports.clone();
                store.retain(now);
                if store.reports != before
                    && store.repository.save_reports(&store.document()).is_err()
                {
                    store.reports_blocked = true;
                }
            }
            Ok(None) => {}
            _ => store.reports_blocked = true,
        }
        store
    }
    pub fn warning(&self) -> Option<ApiError> {
        (self.settings_blocked
            || self.reports_blocked
            || self.secret_warning
            || self.cleanup_warning)
            .then(storage_error)
    }
    pub fn settings_view(&self) -> SettingsView {
        SettingsView {
            report_mode: self.settings.values.report_mode,
            provider: self.settings.values.provider.clone(),
            excluded_apps: self.settings.values.excluded_apps.clone(),
            reduced_motion: self.settings.values.reduced_motion,
            ocr_enabled: self.settings.values.ocr_enabled,
            notification_sound: self.settings.values.notification_sound,
            revision: self.settings.revision,
            has_api_key: self.settings.secret_id.is_some() && !self.secret_warning,
        }
    }
    pub fn secret_id(&self) -> Option<Id> {
        self.settings.secret_id.clone()
    }
    pub fn read_secret(&self, id: &Id) -> Result<Secret, ApiError> {
        let secret = self.secrets.read(id).map_err(|_| storage_error())?;
        if !valid_key(&secret.0) {
            return Err(storage_error());
        }
        Ok(secret)
    }
    pub fn update(&mut self, request: &UpdateSettingsRequest) -> Result<SettingsView, ApiError> {
        if self.settings_blocked {
            return Err(storage_error());
        }
        if request.expected_settings_revision != self.settings.revision {
            return Err(ApiError::new(
                ErrorCode::StaleRevision,
                "設定を読み直してください。",
            ));
        }
        validate_settings(&request.values)?;
        let revision = SafeInt::try_from(
            self.settings
                .revision
                .get()
                .checked_add(1)
                .ok_or_else(storage_error)?,
        )
        .map_err(|_| storage_error())?;
        let changed_provider = self
            .settings
            .values
            .provider
            .as_ref()
            .map(|p| (&p.kind, &p.endpoint))
            != request
                .values
                .provider
                .as_ref()
                .map(|p| (&p.kind, &p.endpoint));
        let old_secret = self.settings.secret_id.clone();
        let new_secret = match &request.key_change {
            KeyChange::Replace { value } => {
                if !valid_key(value.as_bytes()) {
                    return Err(ApiError::validation());
                }
                Some(self.secrets.put(value).map_err(|_| storage_error())?)
            }
            KeyChange::Remove => None,
            KeyChange::Keep if changed_provider => None,
            KeyChange::Keep => old_secret.clone(),
        };
        let saved = SavedSettings {
            schema_version: 1,
            revision,
            values: request.values.clone(),
            secret_id: new_secret.clone(),
        };
        if self.repository.save_settings(&saved).is_err() {
            if new_secret != old_secret {
                if let Some(id) = &new_secret {
                    let _ = self.secrets.remove(id);
                }
            }
            return Err(storage_error());
        }
        self.settings = saved;
        if new_secret != old_secret {
            self.secret_warning = false;
            if let Some(id) = &old_secret {
                if self.secrets.remove(id).is_err() {
                    self.cleanup_warning = true;
                }
            }
        }
        Ok(self.settings_view())
    }
    fn document(&self) -> SavedReports {
        SavedReports {
            schema_version: 1,
            reports: self.reports.clone(),
        }
    }
    fn retain(&mut self, now: u64) {
        self.reports.retain(|report| {
            report.created_at.get() <= now && now - report.created_at.get() <= REPORT_RETENTION_MS
        });
        self.reports.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.as_str().cmp(b.id.as_str()))
        });
        self.reports.truncate(REPORT_LIMIT);
    }
    fn prune(&mut self, now: u64) -> Result<(), ApiError> {
        self.volatile_reports.retain(|report| {
            report.created_at.get() <= now && now - report.created_at.get() <= REPORT_RETENTION_MS
        });
        if self.reports_blocked {
            return Err(storage_error());
        }
        let before = self.reports.clone();
        self.retain(now);
        if before != self.reports {
            self.epoch += 1;
            if self.repository.save_reports(&self.document()).is_err() {
                self.reports_blocked = true;
                return Err(storage_error());
            }
        }
        Ok(())
    }
    /// B-06 の完了処理から使用。呼出元が実行世代を確認してから確定する。
    pub fn save_report(&mut self, report: Report, now: u64) -> Result<(), ApiError> {
        if self.reports_blocked {
            return Err(storage_error());
        }
        if !validate_report(&report) || report.created_at.get() > now {
            return Err(ApiError::validation());
        }
        if self
            .reports
            .iter()
            .any(|old| old.id != report.id && old.session_id == report.session_id)
        {
            return Err(ApiError::validation());
        }
        if self.reports.iter().any(|old| {
            // 固定した作業履歴は不変。OCR 未取得のカードへの初回補足だけを許可する。
            let mut original_history = old.history.clone();
            if original_history.ocr.is_none() {
                original_history.ocr = report.history.ocr.clone();
            }
            old.id == report.id
                && (old.session_id != report.session_id
                    || original_history != report.history
                    || old.created_at != report.created_at
                    || old.trigger != report.trigger
                    || old.updated_at > report.updated_at
                    || old.attempt > report.attempt)
        }) {
            return Err(ApiError::validation());
        }
        let before = self.reports.clone();
        self.reports.retain(|old| old.id != report.id);
        let report_id = report.id.clone();
        self.reports.push(report);
        self.retain(now);
        if self.repository.save_reports(&self.document()).is_err() {
            self.reports = before;
            return Err(storage_error());
        }
        self.epoch += 1;
        self.volatile_reports.retain(|old| old.id != report_id);
        Ok(())
    }
    /// 遅い保存中に世代が変わった場合は旧保存内容へ戻す。削除と同じ保存ロックで直列化する。
    pub fn save_report_guarded(
        &mut self,
        report: Report,
        now: u64,
        current: impl Fn() -> bool,
    ) -> Result<(), ApiError> {
        let cancelled = || {
            ApiError::new(
                ErrorCode::Cancelled,
                "このレポートの作成は取り消されました。",
            )
        };
        if !current() {
            return Err(cancelled());
        }
        let before = self.reports.clone();
        let volatile = self.volatile_reports.clone();
        let epoch = self.epoch;
        let result = self.save_report(report, now);
        if current() {
            return result;
        }
        self.reports = before;
        self.volatile_reports = volatile;
        self.epoch = epoch;
        if result.is_ok() && self.repository.save_reports(&self.document()).is_err() {
            self.reports_blocked = true;
            return Err(storage_error());
        }
        Err(cancelled())
    }
    /// 保存失敗のカードは実行中だけ参照可能。永続化の成功とは扱わない。
    pub fn remember_failure(&mut self, report: Report) {
        debug_assert_eq!(report.status, ReportStatus::Failed);
        self.volatile_reports.retain(|old| old.id != report.id);
        self.volatile_reports.push(report);
        self.volatile_reports
            .sort_by(|a, b| b.created_at.cmp(&a.created_at));
        self.volatile_reports.truncate(REPORT_LIMIT);
        self.epoch += 1;
    }
    fn visible(&self) -> Vec<&Report> {
        let mut reports: Vec<_> = self
            .reports
            .iter()
            .filter(|report| {
                !self
                    .volatile_reports
                    .iter()
                    .any(|overlay| overlay.id == report.id)
            })
            .chain(self.volatile_reports.iter())
            .collect();
        reports.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.as_str().cmp(b.id.as_str()))
        });
        reports.truncate(REPORT_LIMIT);
        reports
    }
    pub fn list(
        &mut self,
        request: &ListReportsRequest,
        now: u64,
        runtime: &Id,
    ) -> Result<ReportPage, ApiError> {
        if !(1..=20).contains(&request.limit.get()) {
            return Err(ApiError::validation());
        }
        self.prune(now)?;
        let prefix = format!("{}:{}:", runtime.as_str(), self.epoch);
        let visible = self.visible();
        let offset = match &request.cursor {
            None => 0,
            Some(cursor) => cursor
                .strip_prefix(&prefix)
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|offset| *offset > 0 && *offset < visible.len())
                .ok_or_else(ApiError::validation)?,
        };
        let items: Vec<_> = visible
            .iter()
            .skip(offset)
            .take(request.limit.get() as usize)
            .map(|report| ReportListItem {
                id: report.id.clone(),
                session_id: report.session_id.clone(),
                created_at: report.created_at,
                updated_at: report.updated_at,
                status: report.status,
            })
            .collect();
        let next = offset + items.len();
        Ok(ReportPage {
            items,
            next_cursor: (next < visible.len()).then(|| format!("{prefix}{next}")),
        })
    }
    pub fn get(&mut self, id: &Id, now: u64) -> Result<Report, ApiError> {
        self.prune(now)?;
        self.visible()
            .into_iter()
            .find(|report| report.id == *id)
            .cloned()
            .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "レポートがありません。"))
    }
    pub fn clear(&mut self) -> Result<(), ApiError> {
        if self.reports_blocked {
            return Err(storage_error());
        }
        self.reports.clear();
        self.volatile_reports.clear();
        self.epoch += 1;
        if self.repository.save_reports(&self.document()).is_err() {
            self.reports_blocked = true;
            return Err(storage_error());
        }
        Ok(())
    }
}
#[cfg(test)]
pub(crate) mod tests;
fn valid_key(value: &[u8]) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.iter().all(|byte| byte.is_ascii_graphic())
}
fn unique_reports(reports: &[Report]) -> bool {
    let mut ids = HashSet::new();
    let mut sessions = HashSet::new();
    reports
        .iter()
        .all(|report| ids.insert(report.id.as_str()) && sessions.insert(report.session_id.as_str()))
}
