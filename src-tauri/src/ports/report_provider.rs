//! 通信実装を生成ワーカーから分離する。秘密・HTTP本文をエラーへ含めない。
use crate::{ipc::dto::*, ports::storage::Secret};

pub trait ReportProvider: Send + Sync {
    fn generate(
        &self,
        settings: &ProviderSettings,
        key: &Secret,
        history: &HistorySnapshot,
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<ReportContent, ApiError>;
}

/// 設定保存・開始・送信直前の全境界で同じ規則を使う。
pub fn validate_provider(settings: &ProviderSettings) -> Result<url::Url, ApiError> {
    let invalid = ApiError::validation;
    if settings.endpoint.chars().count() > 2048
        || settings.endpoint != settings.endpoint.trim()
        || settings.endpoint.chars().any(char::is_control)
        || settings.model.chars().count() > 200
        || settings.model.trim().is_empty()
        || settings.model != settings.model.trim()
        || settings.model.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    if settings.kind == ProviderKind::Gemini
        && !settings
            .model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err(invalid());
    }
    let url = url::Url::parse(&settings.endpoint).map_err(|_| invalid())?;
    let local = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.host().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}
