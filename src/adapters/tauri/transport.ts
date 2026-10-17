import type { IpcCommands } from "../../contracts/ipc.js";

export type Unsubscribe = () => void;
/** unknown を返す境界。TauriGateway が成功・失敗の両方を検証する。 */
export interface IpcTransport {
  invoke(command: keyof IpcCommands, args?: { request: unknown }): Promise<unknown>;
  listen(event: string, onPayload: (payload: unknown) => void): Promise<Unsubscribe>;
}
export interface GatewayEnvironment {
  every(milliseconds: number, callback: () => void): Unsubscribe;
  onResume(callback: () => void): Unsubscribe;
  onUnload?(callback: () => void): Unsubscribe;
  requestId(): string;
}
export const browserEnvironment: GatewayEnvironment = {
  every: (milliseconds, callback) => { const timer = setInterval(callback, milliseconds); return () => clearInterval(timer); },
  onResume: callback => {
    const visible = () => { if (document.visibilityState === "visible") callback(); };
    window.addEventListener("focus", callback);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", callback); document.removeEventListener("visibilitychange", visible); };
  },
  requestId: () => crypto.randomUUID(),
  onUnload: callback => { window.addEventListener("pagehide", callback); return () => window.removeEventListener("pagehide", callback); },
};
