import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IpcTransport } from "./transport.js";

export const nativeTransport: IpcTransport = {
  invoke: (command, args) => invoke<unknown>(command, args),
  listen: (event, onPayload) => listen<unknown>(event, message => onPayload(message.payload)),
};
