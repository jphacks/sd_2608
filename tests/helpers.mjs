import path from "node:path";
import { pathToFileURL } from "node:url";

export function fromBuild(file) {
  if (!process.env.SD2608_TEST_BUILD) throw new Error("npm test から実行してください。");
  return import(pathToFileURL(path.join(process.env.SD2608_TEST_BUILD, file)).href);
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function answerInput(snapshot, answer) {
  return { trackingId: snapshot.runtime.trackingId, sessionId: snapshot.reminder.sessionId,
    reminderId: snapshot.reminder.id, answer };
}
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
