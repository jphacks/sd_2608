//! 画像と生の認識結果は取得処理内だけで所有し、ログには出さない。
pub struct OcrWindow {
    pub key: crate::domain::WindowKey,
    pub app_name: String,
    pub title: String,
    pub text: String,
}
#[derive(Default)]
pub struct OcrBatch {
    pub windows: Vec<OcrWindow>,
    pub unavailable: usize,
}
pub trait ScreenOcr: Send + Sync {
    fn collect(
        &self,
        excluded: &[String],
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<OcrBatch, ()>;
}
