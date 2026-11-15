/** How long the vibration on a phase change lasts, in milliseconds: long enough to feel through a car's seat or a hand, short enough not to startle. */
export const PHASE_VIBRATION_MS = 200;

/**
 * Tells the person a new phase has begun without their eyes on the screen: a short vibration where the device has one, and the text read aloud when `speak` is set and the browser can speak.
 */
export function announcePhase(text: string, speak: boolean): void {
  if ("vibrate" in navigator) navigator.vibrate(PHASE_VIBRATION_MS);
  if (!speak || !("speechSynthesis" in window)) return;
  // The newest phase matters; an instruction still being read is stale.
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
