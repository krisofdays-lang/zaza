// Small, dependency-free completion chime played when a workflow finishes.
// Synthesized with the Web Audio API so we don't have to ship an audio asset.
// A short two-note arpeggio: pleasant "ding-ding" that clearly signals "done".
export function playCompletionChime() {
  if (typeof window === "undefined") return
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()

    // Two ascending notes (C6 -> E6) with a soft attack/decay envelope.
    const notes = [
      { freq: 1046.5, start: 0, dur: 0.18 },
      { freq: 1318.5, start: 0.16, dur: 0.28 },
    ]
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = n.freq
      const t0 = ctx.currentTime + n.start
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + n.dur + 0.02)
    }

    // Release the context shortly after the sound finishes.
    window.setTimeout(() => ctx.close().catch(() => {}), 800)
  } catch {
    // Autoplay restrictions or unsupported context — sound is best-effort.
  }
}
