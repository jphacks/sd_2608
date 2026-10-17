import type { FaceInput } from "../contracts/domain.js";
/** センサーが送るのは boolean / unavailable とメタデータだけ。送信完了を待って次へ進む。 */
export interface FaceCapture {
  start(trackingId: string, submit: (input: FaceInput) => Promise<boolean>): void;
  stop(): void;
}
export interface ManualFaceCapture extends FaceCapture {
  setFaceDetected(value: boolean): void;
}
export type FaceCaptures = { camera: FaceCapture; manual?: ManualFaceCapture };
