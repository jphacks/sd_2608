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
  return <><div className="fld"><input aria-label="今回の作業" maxLength={120} autoFocus value={value} placeholder="何をする？（空でもOK）" onChange={e => onChange(e.target.value)} /><button className={`mic${listening ? " on" : ""}`} type="button" aria-label={listening ? "音声入力を止める" : "音声入力"} aria-pressed={listening} onClick={toggle}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></button></div><p className="sm2" role="status">{message || (listening ? "聞いています… もう一度タップで停止" : "")}</p><details><summary className="sm2">音声入力について</summary><p className="sm">任意です。音声認識の処理先は利用するブラウザーに依存します。</p></details></>;
}
