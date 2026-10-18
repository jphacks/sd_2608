type Request = { requestId: string; image: string | null };
interface Transport {
  listen(event: string, callback: (payload: unknown) => void): Promise<() => void>;
  invoke(command: string, args: unknown): Promise<unknown>;
}
/** OCR の依頼だけを購読する。画像は永続化・ログ・AI 送信しない。 */
export function startOcrClient(transport: Transport, recognize: (image: string, signal: AbortSignal) => Promise<string>): () => void {
  let live = true;
  let active: { id: string; controller: AbortController } | null = null;
  const subscribed = transport.listen("app://ocr-request", payload => {
    if (!live || !payload || typeof payload !== "object") return;
    const { requestId, image } = payload as Partial<Request>;
    if (typeof requestId !== "string" || !/^ocr-\d+-\d+$/.test(requestId)) return;
    if (image === null) { if (active?.id === requestId) active.controller.abort(); return; }
    if (typeof image !== "string" || image.length > 16_000_025 || !image.startsWith("data:image/png;base64,")) return;
    active?.controller.abort();
    const operation = { id: requestId, controller: new AbortController() };
    active = operation;
    void (async () => {
      let text = "", failed = false;
      try { text = (await recognize(image, operation.controller.signal)).slice(0, 32_768); }
      catch { failed = true; }
      if (!live || operation.controller.signal.aborted || active !== operation) return;
      active = null;
      try { await transport.invoke("ocr_complete", { request: { requestId, text, failed } }); } catch { /* Rust の期限で解放する。 */ }
    })();
  });
  void subscribed.catch(() => {});
  return () => { live = false; active?.controller.abort(); active = null; void subscribed.then(unlisten => unlisten()).catch(() => {}); };
}
