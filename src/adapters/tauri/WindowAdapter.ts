import { getCurrentWindow, currentMonitor, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import type { WindowAdapter } from "../../ports/WindowAdapter.js";

export const nativeWindow: WindowAdapter = {
  pin: value => getCurrentWindow().setAlwaysOnTop(value),
  drag: () => getCurrentWindow().startDragging(),
  close: () => getCurrentWindow().close(),
  async place() {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const window = getCurrentWindow();
    let size = await window.outerSize();
    const { position, size: area } = monitor.workArea;
    const scale = monitor.scaleFactor;
    // 150% 表示などで760 logical pxが作業領域を超える場合だけ収める。
    if (size.width > area.width - 32 * scale || size.height > area.height - 32 * scale) {
      await window.setSize(new LogicalSize(
        Math.min(size.width / scale, area.width / scale - 32),
        Math.min(size.height / scale, area.height / scale - 32),
      ));
      size = await window.outerSize();
    }
    // workArea は物理座標。負座標の別モニターと表示倍率も考慮する。
    await window.setPosition(new LogicalPosition(
      (position.x + Math.max(0, area.width - size.width - 16 * scale)) / scale,
      (position.y + Math.max(0, area.height - size.height - 16 * scale)) / scale,
    ));
  },
};
