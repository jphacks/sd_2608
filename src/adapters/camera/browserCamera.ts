import type { CameraDependencies } from "./FaceDetectionController.js";

export const browserCamera: CameraDependencies = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: false,
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } }),
  createVideo: () => document.createElement("video"),
  loadDetector: async () => {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const fileset = await FilesetResolver.forVisionTasks(new URL("mediapipe/wasm/", base).href);
    const detector = await FaceDetector.createFromOptions(fileset, { baseOptions: {
      modelAssetPath: new URL("models/blaze_face_short_range.tflite", base).href, delegate: "CPU",
    }, runningMode: "VIDEO", minDetectionConfidence: 0.5 });
    return { detect: (video, timestamp) => detector.detectForVideo(video, timestamp).detections.length > 0,
      close: () => detector.close() };
  },
  now: () => Date.now(),
  monotonic: () => performance.now(),
  after: (milliseconds, callback) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); },
};
