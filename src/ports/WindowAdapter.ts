/** OS ウィンドウ操作。監視・レポートの状態は持たない。 */
export interface WindowAdapter {
  pin(value: boolean): Promise<void>;
  drag(): Promise<void>;
  close(): Promise<void>;
  place(): Promise<void>;
}
