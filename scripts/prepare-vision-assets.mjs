import { cp, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const sdk = new URL("./", import.meta.resolve("@mediapipe/tasks-vision"));
const destination = new URL("../public/mediapipe/", import.meta.url);
await mkdir(destination, { recursive: true });
const metadata = JSON.parse(await readFile(new URL("package.json", sdk), "utf8"));
if (metadata.version !== "0.10.35" || metadata.license !== "Apache-2.0") throw new Error("Unexpected MediaPipe package/version/license");
await cp(new URL("wasm/", sdk), new URL("wasm/", destination), { recursive: true });
// npm 配布物は license メタデータのみ。Apache-2.0 の全文と SDK README を一緒に配布する。
await cp(new URL("../public/models/LICENSE.apache-2.0.txt", import.meta.url), new URL("LICENSE.apache-2.0.txt", destination));
await cp(new URL("README.md", sdk), new URL("SDK-README.md", destination));
const model = new URL("../public/models/blaze_face_short_range.tflite", import.meta.url);
const hash = createHash("sha256").update(await readFile(model)).digest("hex");
if (hash !== "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f") throw new Error("Unexpected face model checksum");
console.log("Local MediaPipe WASM, license and verified face model are ready.");
await import("./prepare-ocr-assets.mjs");
