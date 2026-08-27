import React, { useCallback, useEffect, useRef, useState } from "react";

/*
 * Audible-signal player for the FireAngel ST-622 smoke alarm fitted to the IOS ceiling.
 *
 * No recording of the device is used. The patterns below are synthesised with the Web
 * Audio API from the values documented by the manufacturer. Every value that the
 * manufacturer does NOT document is named UNCONFIRMED_* and carries a TODO(łukasz).
 *
 * Sources
 *   [M] Instrukcja obsługi FireAngel ST-622-PL (Sprue Safety Products Ltd),
 *       https://fireangel-polska.pl/wp-content/uploads/2018/02/Instrukcja-FireAngel-ST-622.pdf
 *   [D] Karta katalogowa FireAngel ST-622 (Termasol Sp. z o.o.),
 *       https://fireangel-polska.pl/wp-content/uploads/2017/12/karta_katalogowa_fireangel_ST-622.pdf
 */

/* [M] p. 7: the audible test gives two cycles of three loud beeps and then stops by itself. */
const TEST_CYCLES = 2;
const BEEPS_PER_CYCLE = 3;

/* [M] p. 7: a low battery or a fault gives a single beep every 40 s. */
const LOW_BATTERY_INTERVAL_MS = 40000;

/*
 * TODO(łukasz): the tone frequency of the sounder is stated in neither [M] nor [D].
 * The value below only makes the player audible; it is not a measured value.
 * Confirm it against the installed unit (or against a Sprue technical datasheet)
 * before this section is issued.
 */
const UNCONFIRMED_TONE_HZ = 3100;

/*
 * TODO(łukasz): beep length, gap between the beeps of one cycle and gap between the two
 * cycles are stated in neither [M] nor [D]. The values below are placeholders chosen so
 * that the documented "three beeps, pause, three beeps" shape can be heard. Measure them
 * on the installed unit and correct them here.
 */
const UNCONFIRMED_BEEP_MS = 500;
const UNCONFIRMED_BEEP_GAP_MS = 500;
const UNCONFIRMED_CYCLE_GAP_MS = 1500;

/*
 * The real low-battery interval is 40 s ([M] p. 7). Waiting 40 s between beeps makes the
 * pattern useless for familiarisation, so the player compresses the silence. The
 * compression is stated on the page and in the caution below.
 */
const DEMO_LOW_BATTERY_GAP_MS = 4000;

/* Playback level of the player. The device itself sounds at 85 dB at 3 m ([D]). */
const PLAYER_GAIN = 0.06;

const PATTERNS = {
  test: {
    label: "Test signal",
    caption:
      "Two cycles of three beeps, then silence. This is what the alarm answers with when the Test button is pressed.",
    /* Returns beep start times (seconds, relative to the start of playback). */
    schedule() {
      const beeps = [];
      let t = 0;
      for (let cycle = 0; cycle < TEST_CYCLES; cycle += 1) {
        for (let beep = 0; beep < BEEPS_PER_CYCLE; beep += 1) {
          beeps.push(t);
          t += (UNCONFIRMED_BEEP_MS + UNCONFIRMED_BEEP_GAP_MS) / 1000;
        }
        t += (UNCONFIRMED_CYCLE_GAP_MS - UNCONFIRMED_BEEP_GAP_MS) / 1000;
      }
      return { beeps, loop: false };
    },
  },
  lowBattery: {
    label: "Low-battery / fault beep",
    caption:
      "A single beep, repeated. On the device the beeps are " +
      LOW_BATTERY_INTERVAL_MS / 1000 +
      " s apart; the player shortens the silence to " +
      DEMO_LOW_BATTERY_GAP_MS / 1000 +
      " s so the beep can be recognised.",
    schedule() {
      const beeps = [];
      for (let i = 0; i < 6; i += 1) {
        beeps.push((i * (UNCONFIRMED_BEEP_MS + DEMO_LOW_BATTERY_GAP_MS)) / 1000);
      }
      return { beeps, loop: true };
    },
  },
};

export default function SmokeAlarmSignal() {
  const [playing, setPlaying] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const audioRef = useRef(null); // { ctx, osc, gain }
  const timerRef = useRef(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const a = audioRef.current;
    audioRef.current = null;
    if (a) {
      try {
        a.gain.gain.cancelScheduledValues(a.ctx.currentTime);
        a.gain.gain.setValueAtTime(0, a.ctx.currentTime);
        a.osc.stop();
      } catch (e) {
        /* the oscillator may already have stopped */
      }
      a.osc.disconnect();
      a.gain.disconnect();
      if (typeof a.ctx.close === "function") a.ctx.close();
    }
    setPlaying(null);
  }, []);

  /* Release the oscillator and the context when the page is left. */
  useEffect(() => stop, [stop]);

  const play = useCallback(
    (key) => {
      stop();
      // The AudioContext is created here, inside the click handler, and never at module
      // scope: the page is server-rendered, and browsers refuse a context that was not
      // opened by a user gesture.
      const Ctor =
        typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      if (!Ctor) {
        setUnsupported(true);
        return;
      }

      const ctx = new Ctor();
      const gain = ctx.createGain();
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(UNCONFIRMED_TONE_HZ, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      osc.connect(gain).connect(ctx.destination);

      const { beeps, loop } = PATTERNS[key].schedule();
      const beepSeconds = UNCONFIRMED_BEEP_MS / 1000;
      const t0 = ctx.currentTime + 0.05;
      beeps.forEach((offset) => {
        const on = t0 + offset;
        gain.gain.setValueAtTime(0, on);
        gain.gain.linearRampToValueAtTime(PLAYER_GAIN, on + 0.01);
        gain.gain.setValueAtTime(PLAYER_GAIN, on + beepSeconds - 0.01);
        gain.gain.linearRampToValueAtTime(0, on + beepSeconds);
      });

      const runSeconds = beeps[beeps.length - 1] + beepSeconds + 0.1;
      osc.start(t0);
      if (!loop) osc.stop(t0 + runSeconds);
      audioRef.current = { ctx, osc, gain };
      setPlaying(key);

      timerRef.current = setTimeout(
        () => (loop ? play(key) : stop()),
        runSeconds * 1000
      );
    },
    [stop]
  );

  return (
    <div className="card" style={{ padding: "1rem", marginBottom: "1rem" }}>
      <strong>Audible signals of the smoke detector</strong>
      <p style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
        {playing ? PATTERNS[playing].caption : "Select a signal to hear its pattern."}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {Object.keys(PATTERNS).map((key) => (
          <button
            key={key}
            type="button"
            className={
              "button " + (playing === key ? "button--primary" : "button--secondary")
            }
            onClick={() => (playing === key ? stop() : play(key))}
          >
            {playing === key ? "Stop" : "Play"} — {PATTERNS[key].label}
          </button>
        ))}
        <button
          type="button"
          className="button button--outline button--secondary"
          onClick={stop}
          disabled={!playing}
        >
          Stop
        </button>
      </div>
      {unsupported && (
        <p style={{ marginTop: "0.5rem" }}>
          This browser provides no Web Audio API, so the pattern cannot be played here.
        </p>
      )}
      <div className="alert alert--warning" style={{ marginTop: "1rem" }}>
        The player reproduces the pattern of the signal for familiarisation only. Tone,
        level and timing differ from the installed device, and playing a pattern here is
        not a substitute for the weekly test of the alarm described below.
      </div>
    </div>
  );
}
