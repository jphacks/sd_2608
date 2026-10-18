//! Wire DTOs: src/contracts/{domain,api,ipc}.ts と同じ JSON 契約。
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::DeserializeOwned};
use serde_json::{Value, json};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct SafeInt(u64);
impl SafeInt {
    pub const ZERO: Self = Self(0);
    pub fn get(self) -> u64 {
        self.0
    }
}
impl TryFrom<u64> for SafeInt {
    type Error = &'static str;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value <= MAX_SAFE_INTEGER {
            Ok(Self(value))
        } else {
            Err("integer out of range")
        }
    }
}
impl From<SafeInt> for u64 {
    fn from(value: SafeInt) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Id(String);
impl Id {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Id {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !value.is_empty() && value.chars().count() <= 256 {
            Ok(Self(value))
        } else {
            Err("invalid id")
        }
    }
}
impl From<Id> for String {
    fn from(value: Id) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct ApiVersion;
impl TryFrom<u8> for ApiVersion {
    type Error = &'static str;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value == 1 {
            Ok(Self)
        } else {
            Err("unsupported API version")
        }
    }
}
impl From<ApiVersion> for u8 {
    fn from(_: ApiVersion) -> Self {
        1
    }
}

// Option であってもプロパティ自体は必須。欠落と明示的な null を区別する。
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

macro_rules! wire_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum $name { $($variant),+ }
    };
}
wire_enum!(TimingProfile { Normal, Demo });
wire_enum!(ReportMode { Local, Ai });
wire_enum!(NotificationSound { Dog, System, None });
impl Default for NotificationSound {
    fn default() -> Self {
        Self::Dog
    }
}
wire_enum!(RuntimePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error
});
wire_enum!(CameraPhase {
    Off,
    Waiting,
    Running,
    Error
});
wire_enum!(ActivityPhase {
    Off,
    Running,
    Error
});
wire_enum!(Presence {
    Present,
    Uncertain,
    Away,
    Unknown
});
wire_enum!(PresenceReason {
    StableFace,
    Stabilizing,
    FaceMissing,
    AwayConfirmed,
    MissingInput,
    SensorUnavailable,
    StaleSample,
    ProtectedScreen
});
wire_enum!(EndReason {
    Away,
    Interrupted,
    Stopped
});
wire_enum!(ReminderSource { Sitting });
wire_enum!(ReminderLevel { Normal, Hard });
wire_enum!(ReminderCause {
    Boundary,
    InitialLimit,
    SnoozeLimit,
    HardLimit
});
wire_enum!(BoundaryKind {
    Idle,
    WindowSwitchIdle
});
wire_enum!(ReportTrigger { Yes, Away });
wire_enum!(JobStatus {
    Scheduled,
    Queued,
    Running,
    Ready,
    Failed,
    Cancelled
});
wire_enum!(ReportStatus {
    Ready,
    Failed,
    Local
});
wire_enum!(ProviderKind {
    Gemini,
    OpenAiCompatible
});
wire_enum!(FaceSource { Camera, Manual });
wire_enum!(UnavailableReason {
    Denied,
    Stopped,
    DeviceError
});
wire_enum!(Answer { Yes, No });
wire_enum!(ErrorCode {
    Validation,
    InvalidState,
    StaleRevision,
    StaleTracking,
    StaleReminder,
    NotFound,
    ConsentRequired,
    ProviderNotConfigured,
    PermissionDenied,
    StorageFailure,
    NetworkFailure,
    Timeout,
    InvalidResponse,
    Cancelled,
    Internal
});

macro_rules! wire_struct {
    ($name:ident { $($(#[$attribute:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $($(#[$attribute])* pub $field: $ty),* }
    };
}
wire_struct!(ApiError {
    code: ErrorCode,
    message: String,
    retryable: bool
});
impl ApiError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }
    pub fn validation() -> Self {
        Self::new(ErrorCode::Validation, "要求の形式・値を確認してください。")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApiResult<T> {
    Success(T),
    Failure(ApiError),
}
impl<T: Serialize> Serialize for ApiResult<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Success(data) => json!({ "ok": true, "data": data }).serialize(serializer),
            Self::Failure(error) => json!({ "ok": false, "error": error }).serialize(serializer),
        }
    }
}
impl<'de, T: DeserializeOwned> Deserialize<'de> for ApiResult<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let invalid = || serde::de::Error::custom("invalid API envelope");
        let object = value.as_object().ok_or_else(invalid)?;
        if object.len() != 2 {
            return Err(invalid());
        }
        match object.get("ok").and_then(Value::as_bool) {
            Some(true) => object
                .get("data")
                .cloned()
                .ok_or_else(invalid)
                .and_then(|data| serde_json::from_value(data).map_err(serde::de::Error::custom))
                .map(Self::Success),
            Some(false) => object
                .get("error")
                .cloned()
                .ok_or_else(invalid)
                .and_then(|error| serde_json::from_value(error).map_err(serde::de::Error::custom))
                .map(Self::Failure),
            None => Err(invalid()),
        }
    }
}

wire_struct!(Consent {
    activity: bool,
    history: bool,
    external_report: bool
});
wire_struct!(ProviderSettings {
    kind: ProviderKind,
    endpoint: String,
    model: String
});
wire_struct!(SettingsInput {
    report_mode: ReportMode, #[serde(deserialize_with = "required_nullable")] provider: Option<ProviderSettings>,
    excluded_apps: Vec<String>, reduced_motion: bool,
    #[serde(default)] ocr_enabled: bool,
    #[serde(default)] notification_sound: NotificationSound,
});
wire_struct!(SettingsView {
    report_mode: ReportMode, #[serde(deserialize_with = "required_nullable")] provider: Option<ProviderSettings>,
    excluded_apps: Vec<String>, reduced_motion: bool, revision: SafeInt, has_api_key: bool,
    ocr_enabled: bool,
    notification_sound: NotificationSound,
});
wire_struct!(RuntimeState {
    phase: RuntimePhase, #[serde(deserialize_with = "required_nullable")] tracking_id: Option<Id>,
    profile: TimingProfile, effective_report_mode: ReportMode, camera: CameraPhase, activity: ActivityPhase, consent: Consent,
});
impl RuntimeState {
    pub fn stopped(profile: TimingProfile) -> Self {
        Self {
            phase: RuntimePhase::Stopped,
            tracking_id: None,
            profile,
            effective_report_mode: ReportMode::Local,
            camera: CameraPhase::Off,
            activity: ActivityPhase::Off,
            consent: Consent {
                activity: false,
                history: false,
                external_report: false,
            },
        }
    }
}
wire_struct!(PresenceState {
    value: Presence, reason: PresenceReason,
    #[serde(deserialize_with = "required_nullable")] face_missing_since: Option<SafeInt>,
    #[serde(deserialize_with = "required_nullable")] away_detected_at: Option<SafeInt>,
});
wire_struct!(SittingSession {
    id: Id, started_at: SafeInt, #[serde(deserialize_with = "required_nullable")] ended_at: Option<SafeInt>,
    #[serde(deserialize_with = "required_nullable")] end_reason: Option<EndReason>, elapsed_ms: SafeInt,
    #[serde(deserialize_with = "required_nullable")] report_job_id: Option<Id>,
});
wire_struct!(Boundary {
    id: Id,
    occurred_at: SafeInt,
    kind: BoundaryKind
});
wire_struct!(Reminder {
    id: Id,
    session_id: Id,
    source: ReminderSource,
    level: ReminderLevel,
    cause: ReminderCause,
    shown_at: SafeInt
});
wire_struct!(AdvanceNotice {
    session_id: Id,
    remaining_ms: SafeInt
});
wire_struct!(ActivitySegment {
    id: Id,
    session_id: Id,
    started_at: SafeInt,
    ended_at: SafeInt,
    app_name: String,
    masked_title: String,
    #[serde(default)] window_ref: Option<Id>
});
wire_struct!(WindowOcr {
    app_name: String,
    masked_title: String,
    text: String
});
wire_struct!(OcrContext { captured_at: SafeInt, windows: Vec<WindowOcr>, unavailable_windows: SafeInt, unmatched_windows: SafeInt });
wire_struct!(HistorySnapshot { id: Id, session_id: Id, captured_at: SafeInt, range_start: SafeInt, range_end: SafeInt, segments: Vec<ActivitySegment>, #[serde(default)] ocr: Option<OcrContext> });
wire_struct!(ReportJobView {
    id: Id, session_id: Id, trigger: ReportTrigger, requested_at: SafeInt, due_at: SafeInt, status: JobStatus,
    attempt: SafeInt, #[serde(deserialize_with = "required_nullable")] completion_seq: Option<SafeInt>,
});
wire_struct!(ReportContent { summary: String, observed_facts: Vec<String>, #[serde(deserialize_with = "required_nullable")] next_action: Option<String> });
wire_struct!(Report {
    id: Id, session_id: Id, trigger: ReportTrigger, created_at: SafeInt, updated_at: SafeInt, attempt: SafeInt,
    status: ReportStatus, history: HistorySnapshot,
    #[serde(deserialize_with = "required_nullable")] content: Option<ReportContent>,
    #[serde(deserialize_with = "required_nullable")] error: Option<ApiError>,
});
wire_struct!(AppSnapshot {
    api_version: ApiVersion, runtime_id: Id, revision: SafeInt, emitted_at: SafeInt, runtime: RuntimeState,
    settings: SettingsView, presence: PresenceState,
    #[serde(deserialize_with = "required_nullable")] session: Option<SittingSession>,
    #[serde(deserialize_with = "required_nullable")] reminder: Option<Reminder>,
    #[serde(deserialize_with = "required_nullable")] advance_notice: Option<AdvanceNotice>,
    jobs: Vec<ReportJobView>, completion_seq: SafeInt,
    #[serde(deserialize_with = "required_nullable")] warning: Option<ApiError>,
});
impl AppSnapshot {
    pub fn initial(runtime_id: Id, now: SafeInt) -> Self {
        Self {
            api_version: ApiVersion,
            runtime_id,
            revision: SafeInt::ZERO,
            emitted_at: now,
            runtime: RuntimeState::stopped(TimingProfile::Normal),
            settings: SettingsView {
                report_mode: ReportMode::Local,
                provider: None,
                excluded_apps: vec![],
                reduced_motion: false,
                ocr_enabled: false,
                notification_sound: NotificationSound::default(),
                revision: SafeInt::ZERO,
                has_api_key: false,
            },
            presence: PresenceState {
                value: Presence::Unknown,
                reason: PresenceReason::SensorUnavailable,
                face_missing_since: None,
                away_detected_at: None,
            },
            session: None,
            reminder: None,
            advance_notice: None,
            jobs: vec![],
            completion_seq: SafeInt::ZERO,
            warning: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FaceInput {
    Sample {
        tracking_id: Id,
        sequence: SafeInt,
        observed_at: SafeInt,
        source: FaceSource,
        face_detected: bool,
    },
    Unavailable {
        tracking_id: Id,
        sequence: SafeInt,
        observed_at: SafeInt,
        source: FaceSource,
        reason: UnavailableReason,
    },
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum KeyChange {
    Keep,
    Replace { value: String },
    Remove,
}
// キーを Debug 出力しない。
impl std::fmt::Debug for KeyChange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyChange([redacted])")
    }
}
wire_struct!(StartRuntimeRequest {
    request_id: Id,
    profile: TimingProfile,
    expected_settings_revision: SafeInt,
    report_mode: ReportMode,
    consent: Consent
});
wire_struct!(StopRuntimeRequest {
    request_id: Id,
    tracking_id: Id
});
wire_struct!(RespondReminderRequest {
    request_id: Id,
    tracking_id: Id,
    session_id: Id,
    reminder_id: Id,
    answer: Answer
});
wire_struct!(UpdateSettingsRequest {
    request_id: Id,
    expected_settings_revision: SafeInt,
    values: SettingsInput,
    key_change: KeyChange
});
wire_struct!(ListReportsRequest { #[serde(deserialize_with = "required_nullable")] cursor: Option<String>, limit: SafeInt });
wire_struct!(GetReportRequest { report_id: Id });
wire_struct!(RetryReportRequest {
    request_id: Id,
    report_id: Id,
    expected_attempt: SafeInt
});
wire_struct!(ClearDataRequest { request_id: Id });
wire_struct!(FaceReceipt {
    accepted_sequence: SafeInt,
    snapshot_revision: SafeInt
});
wire_struct!(RespondReminderResult { snapshot: AppSnapshot, #[serde(deserialize_with = "required_nullable")] report_id: Option<Id> });
wire_struct!(ReportListItem {
    id: Id,
    session_id: Id,
    created_at: SafeInt,
    updated_at: SafeInt,
    status: ReportStatus
});
wire_struct!(ReportPage { items: Vec<ReportListItem>, #[serde(deserialize_with = "required_nullable")] next_cursor: Option<String> });

#[cfg(test)]
mod tests;
