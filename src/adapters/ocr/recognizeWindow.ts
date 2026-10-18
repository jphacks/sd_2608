import { createWorker, OEM, PSM } from "tesseract.js";

/** One local worker per window; no image, text or model cache in browser storage. */
export async function recognizeWindow(image: string, signal: AbortSignal): Promise<string> {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let cancelled = false;
  let rejectOperation!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectOperation = reject; });
  const cancel = () => { cancelled = true; void worker?.terminate(); rejectOperation(new Error("OCR を中止しました。履歴だけでも続けられます。")); };
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 60_000);
  try {
    if (signal.aborted) throw new Error("OCR を中止しました。");
    return await Promise.race([interrupted, (async () => {
      worker = await createWorker(["jpn", "eng"], OEM.LSTM_ONLY, {
        workerPath: new URL("/ocr/worker.min.js", location.href).href,
        corePath: new URL("/ocr/core/", location.href).href,
        langPath: new URL("/ocr/lang", location.href).href,
        cacheMethod: "none",
        workerBlobURL: false,
        errorHandler: () => { cancelled = true; void worker?.terminate(); rejectOperation(new Error("OCR を読み込めませんでした。履歴だけでも続けられます。")); },
      });
      if (cancelled || signal.aborted) { await worker.terminate(); throw new Error("OCR を中止しました。"); }
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      const { data } = await worker.recognize(image);
      return data.text.slice(0, 12_000);
    })()]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    void worker?.terminate();
  }
}
