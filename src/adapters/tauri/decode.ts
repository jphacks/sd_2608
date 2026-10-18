import type {
  ApiError, ApiResult, AppSnapshot, FaceInput, Report,
} from "../../contracts/domain.js";
import type { IpcCommands } from "../../contracts/ipc.js";

export class DecodeError extends Error {
  constructor() { super("アプリからの応答形式を確認できません。アプリを更新して再接続してください。"); }
}
export type Decoder<T> = (value: unknown) => T;
type Shape = Record<string, Decoder<unknown>>;
type Decoded<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
const invalid = (): never => { throw new DecodeError(); };
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const string: Decoder<string> = value => typeof value === "string" ? value : invalid();
const id: Decoder<string> = value => { const text = string(value); return text.length > 0 && Array.from(text).length <= 256 ? text : invalid(); };
const boolean: Decoder<boolean> = value => typeof value === "boolean" ? value : invalid();
const integer: Decoder<number> = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const literal = <T extends string | number | boolean>(expected: T): Decoder<T> => value => value === expected ? expected : invalid();
const oneOf = <const T extends readonly string[]>(...values: T): Decoder<T[number]> => value =>
  typeof value === "string" && values.includes(value) ? value as T[number] : invalid();
const nullable = <T>(decode: Decoder<T>): Decoder<T | null> => value => value === null ? null : decode(value);
const array = <T>(decode: Decoder<T>): Decoder<T[]> => value => Array.isArray(value) ? value.map(decode) : invalid();
function object<S extends Shape>(shape: S): Decoder<Decoded<S>> {
  return value => {
    const input = record(value);
    if (Object.keys(input).some(key => !owns(shape, key))) invalid();
    const output: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(shape)) {
      if (!owns(input, key)) invalid();
      output[key] = decode(input[key]);
    }
    // 全キーを個別に実行時検証した後にのみ、対応する型を返す。
    return output as Decoded<S>;
  };
}
function union<A, B>(a: Decoder<A>, b: Decoder<B>): Decoder<A | B> {
  return value => {
    try { return a(value); } catch (error) { if (!(error instanceof DecodeError)) throw error; }
    return b(value);
  };
}

const errorDecoder: Decoder<ApiError> = object({
  code: oneOf("validation", "invalidState", "staleRevision", "staleTracking", "staleReminder", "notFound", "consentRequired",
    "providerNotConfigured", "permissionDenied", "storageFailure", "networkFailure", "timeout", "invalidResponse", "cancelled", "internal"),
  message: string, retryable: boolean,
});
const consent = object({ activity: boolean, history: boolean, externalReport: boolean });
const provider = object({ kind: oneOf("gemini", "openAiCompatible"), endpoint: string, model: string });
const settings = object({ reportMode: oneOf("local", "ai"), provider: nullable(provider), excludedApps: array(string),
  reducedMotion: boolean, revision: integer, hasApiKey: boolean });
const runtime = object({ phase: oneOf("stopped", "starting", "running", "stopping", "error"), trackingId: nullable(id),
  profile: oneOf("normal", "demo"), effectiveReportMode: oneOf("local", "ai"), camera: oneOf("off", "waiting", "running", "error"),
  activity: oneOf("off", "running", "error"), consent });
const presence = object({ value: oneOf("present", "uncertain", "away", "unknown"), reason: oneOf("stableFace", "stabilizing", "faceMissing",
  "awayConfirmed", "missingInput", "sensorUnavailable", "staleSample", "protectedScreen"), faceMissingSince: nullable(integer), awayDetectedAt: nullable(integer) });
const session = object({ id, startedAt: integer, endedAt: nullable(integer), endReason: nullable(oneOf("away", "interrupted", "stopped")), elapsedMs: integer, reportJobId: nullable(id) });
const reminder = object({ id, sessionId: id, source: literal("sitting"), level: oneOf("normal", "hard"),
  cause: oneOf("boundary", "initialLimit", "snoozeLimit", "hardLimit"), shownAt: integer });
const job = object({ id, sessionId: id, trigger: oneOf("yes", "away"), requestedAt: integer, dueAt: integer,
  status: oneOf("scheduled", "queued", "running", "ready", "failed", "cancelled"), attempt: integer, completionSeq: nullable(integer) });
export const snapshotDecoder: Decoder<AppSnapshot> = object({
  apiVersion: literal(1), runtimeId: id, revision: integer, emittedAt: integer, runtime, settings, presence,
  session: nullable(session), reminder: nullable(reminder), advanceNotice: nullable(object({ sessionId: id, remainingMs: integer })),
  jobs: array(job), completionSeq: integer, warning: nullable(errorDecoder),
});
const segment = object({ id, sessionId: id, startedAt: integer, endedAt: integer, appName: string, maskedTitle: string });
const history = object({ id, sessionId: id, capturedAt: integer, rangeStart: integer, rangeEnd: integer, segments: array(segment) });
const content = object({ summary: string, observedFacts: array(string), nextAction: nullable(string) });
export const reportDecoder: Decoder<Report> = object({ id, sessionId: id, trigger: oneOf("yes", "away"), createdAt: integer,
  updatedAt: integer, attempt: integer, status: oneOf("ready", "failed", "local"), history, content: nullable(content), error: nullable(errorDecoder) });
const reportPage = object({ items: array(object({ id, sessionId: id, createdAt: integer, updatedAt: integer, status: oneOf("ready", "failed", "local") })), nextCursor: nullable(string) });
const faceReceipt = object({ acceptedSequence: integer, snapshotRevision: integer });
const respond = object({ snapshot: snapshotDecoder, reportId: nullable(id) });
const faceBase = { trackingId: id, sequence: integer, observedAt: integer, source: oneOf("camera", "manual") };
export const faceInputDecoder: Decoder<FaceInput> = union(
  object({ ...faceBase, kind: literal("sample"), faceDetected: boolean }),
  object({ ...faceBase, kind: literal("unavailable"), reason: oneOf("denied", "stopped", "deviceError") }),
);

const responses: { [K in keyof IpcCommands]: Decoder<IpcCommands[K]["response"]> } = {
  app_get_snapshot: snapshotDecoder, runtime_start: snapshotDecoder, runtime_stop: snapshotDecoder,
  face_submit: faceReceipt, reminder_respond: respond, settings_update: snapshotDecoder,
  report_list: reportPage, report_get: reportDecoder, report_retry: snapshotDecoder, data_clear: snapshotDecoder,
};
export function decodeResult<T>(value: unknown, decode: Decoder<T>): ApiResult<T> {
  return union(object({ ok: literal(true), data: decode }), object({ ok: literal(false), error: errorDecoder }))(value);
}
export function decodeCommandResult<K extends keyof IpcCommands>(command: K, value: unknown): ApiResult<IpcCommands[K]["response"]> {
  return decodeResult(value, responses[command]);
}
