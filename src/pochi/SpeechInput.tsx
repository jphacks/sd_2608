import { useEffect, useRef, useState } from "react";
type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null };
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
export function SpeechInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const recognition = useRef<Recognition | null>(null), [listening, setListening] = useState(false), [message, setMessage] = useState("");
  useEffect(() => () => { const r = recognition.current; if (r) { r.onresult = r.onend = r.onerror = null; try { r.stop(); } catch { /* Already stopped. */ } recognition.current = null; } }, []);
  const toggle = () => {
    if (recognition.current) { recognition.current.stop(); return; }
    const host = window as SpeechWindow, Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
    if (!Constructor) { setMessage("この環境は音声入力に未対応です。文字入力でもOK。"); return; }
    const r = new Constructor(), base = value; let finalText = "";
    r.lang = "ja-JP"; r.interimResults = true; r.continuous = true;
    r.onresult = event => { let interim = ""; for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) finalText += event.results[i][0].transcript; else interim += event.results[i][0].transcript;
    } onChange((base + (base ? " " : "") + finalText + interim).slice(0, 120)); };
    r.onerror = () => setMessage("音声を入力できませんでした。許可とマイクを確認するか、文字を入力してください。");
    r.onend = () => { if (recognition.current === r) { recognition.current = null; setListening(false); } };
    recognition.current = r;
    try { r.start(); setListening(true); setMessage(""); } catch { recognition.current = null; setMessage("音声入力を開始できませんでした。"); }
  };
  return <><button className="pochi-mic" type="button" aria-pressed={listening} onClick={toggle}>{listening ? "音声入力を止める" : "音声で入力"}</button><p className="pochi-muted" role="status">{message || (listening ? "聞いています… もう一度押すと停止します。" : "任意です。音声認識の処理先は利用するブラウザーに依存します。")}</p></>;
}
