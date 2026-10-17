import type { MessageBubbleProps } from "../contracts/ui.js";

export function MessageBubble({ bubble, onAnswer }: MessageBubbleProps) {
  return <section className={`message-bubble message-bubble--${bubble.emphasis}`} aria-label="休憩の提案">
    <p role="status">{bubble.text}</p>
    <div className="actions">
      <button disabled={bubble.disabled} onClick={() => onAnswer("yes")}>{bubble.yesLabel}</button>
      <button disabled={bubble.disabled} onClick={() => onAnswer("no")}>{bubble.noLabel}</button>
    </div>
  </section>;
}
