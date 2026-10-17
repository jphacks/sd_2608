import PochiApp from "../pochi/PochiApp.js";
import type { AppViewProps } from "../contracts/ui.js";

/** 実アプリとモックで同じ A の表示を使用する。 */
export function AppView(props: AppViewProps) {
  return <PochiApp {...props} />;
}
