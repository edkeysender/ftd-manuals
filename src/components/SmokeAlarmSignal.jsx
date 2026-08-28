/**
 * Plays a recording of the smoke alarm's audible signals.
 *
 * An earlier version of this component synthesised the tone. That was wrong: the
 * manufacturer documents neither the frequency nor the pulse timing of the ST-622
 * sounder, so the synthesised signal did not match the installed unit. Teaching an
 * operator the wrong alarm sound is a safety problem, so the synthesiser is gone.
 *
 * This component now plays a recording of the real device and nothing else. Until a
 * recording is supplied it renders a notice saying so, rather than making a sound that
 * has not been verified.
 *
 * To supply one: record the signal from the installed alarm, save it as
 * `static/audio/<name>` and pass its site path, e.g.
 *   <SmokeAlarmSignal src="/audio/st-622-test.mp3" label="Test response" />
 *
 * SSR-safe: the <audio> element is inert until the reader presses play.
 */
import React, { useRef, useState } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./SmokeAlarmSignal.module.css";

export default function SmokeAlarmSignal({ src, label = "Audible signal", note }) {
  const url = useBaseUrl(src || "/");
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!src) {
    return (
      <div className={styles.pending}>
        <strong>Recording not yet available.</strong>{" "}
        The audible signals are described in the table above. No sample is played here because the
        manufacturer publishes neither the tone frequency nor the pulse timing of this alarm, and an
        unverified reproduction could teach the wrong sound.
        <div className={styles.pendingFix}>
          TODO(łukasz): record the signals from the installed alarm and save them under{" "}
          <code>static/audio/</code>.
        </div>
      </div>
    );
  }

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); el.currentTime = 0; setPlaying(false); return; }
    el.play().then(() => setPlaying(true)).catch(() => setFailed(true));
  };

  return (
    <div className={styles.player}>
      <button type="button" className={styles.button} onClick={toggle}>
        {playing ? "Stop" : `Play ${label.toLowerCase()}`}
      </button>
      <span className={styles.meta}>{label}</span>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      {failed && <span className={styles.failed}>Recording could not be played.</span>}
      {note && <p className={styles.note}>{note}</p>}
      <p className={styles.caution}>
        A recording is for familiarisation only. It is not a substitute for the weekly test of the
        installed alarm.
      </p>
    </div>
  );
}
