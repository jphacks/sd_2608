import { nativeTransport } from "../tauri/nativeTransport.js";
import { startOcrClient } from "./OcrClient.js";

export const startBrowserOcr = () => startOcrClient(nativeTransport, async (image, signal) => {
  const { recognizeWindow } = await import("./recognizeWindow.js");
  if (signal.aborted) throw new Error("OCR を中止しました。");
  return recognizeWindow(image, signal);
});
