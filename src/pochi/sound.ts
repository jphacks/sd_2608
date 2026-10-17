import type { Settings } from "./model.js";
let audio: AudioContext | null = null;
export function playNotice(text: string, settings: Pick<Settings, "sound">) {
  if (settings.sound === "silent") return;
  const chime = () => { void new Audio("/pet/pochi/chime.wav").play().catch(() => {}); };
  if (settings.sound === "bark") {
    try {
      audio ??= new AudioContext(); void audio.resume().catch(chime);
      for (const [offset, from, to] of [[0, 520, 330], [.22, 560, 340]]) {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime + offset;
        oscillator.type = "sawtooth"; oscillator.frequency.setValueAtTime(from, now);
        oscillator.frequency.exponentialRampToValueAtTime(to, now + .18);
        gain.gain.setValueAtTime(.09, now); gain.gain.exponentialRampToValueAtTime(.001, now + .18);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + .2);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    } catch { chime(); }
    return;
  }
  const voice = "speechSynthesis" in window ? speechSynthesis.getVoices().find(v => v.lang.startsWith("ja")) : undefined;
  if (settings.sound === "voice" && voice) {
    speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice; utterance.lang = "ja-JP"; utterance.onerror = chime; speechSynthesis.speak(utterance);
  } else chime();
}
