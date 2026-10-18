import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const ocr = new URL("../public/ocr/", import.meta.url);
await mkdir(new URL("core/", ocr), { recursive: true });
await mkdir(new URL("lang/", ocr), { recursive: true });
const modules = new URL("../node_modules/", import.meta.url);
await cp(new URL("tesseract.js/dist/worker.min.js", modules), new URL("worker.min.js", ocr));
await cp(new URL("tesseract.js/LICENSE.md", modules), new URL("LICENSE.tesseract.md", ocr));
const core = new URL("tesseract.js-core/", modules);
await cp(new URL("LICENSE", core), new URL("LICENSE.core.txt", ocr));
// The upstream tessdata repository uses Apache-2.0; retain its license as well
// as the npm language packages' README and license metadata below.
await cp(new URL("LICENSE", core), new URL("LICENSE.tessdata.txt", ocr));
for (const name of await readdir(core)) {
  if (/^tesseract-core.*\.(wasm|js)$/.test(name)) await cp(new URL(name, core), new URL(`core/${name}`, ocr));
}
const hashes = { eng: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91", jpn: "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88" };
for (const [lang, hash] of Object.entries(hashes)) {
  const source = new URL(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, modules);
  if (createHash("sha256").update(await readFile(source)).digest("hex") !== hash) throw Error("Unexpected OCR language asset checksum");
  await cp(source, new URL(`lang/${lang}.traineddata.gz`, ocr));
  await cp(new URL(`@tesseract.js-data/${lang}/README.md`, modules), new URL(`README.${lang}.md`, ocr));
  await cp(new URL(`@tesseract.js-data/${lang}/package.json`, modules), new URL(`package.${lang}.json`, ocr));
}
console.log("Local Japanese/English OCR worker, WASM and verified language assets are ready.");
