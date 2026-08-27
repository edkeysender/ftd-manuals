/**
 * Interactive demonstration of the starting panel.
 *
 * The panel has two parts, both documented in the source FCOM:
 *   - a physical plate with a rotary knob (OFF/ON) and two indicators, NOT READY (red)
 *     and READY (green)  — FCOM fig. 2.2c
 *   - a touchscreen showing the software state, and carrying the virtual shutdown
 *     button that starts the shutdown sequence — FCOM figs. 2 and 3
 *
 * The state machine below follows the sequence the FCOM describes. Real timings are
 * minutes; the demonstration compresses them and says so on the page, because a reader
 * must not take the demonstration's timing as the device's timing.
 *
 * Presentational and SSR-safe: no DOM access during render, and every timer is cleared
 * on unmount or state change.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import styles from "./StartingPanelDemo.module.css";

/**
 * Demonstration-only durations, in milliseconds. The FCOM states that start-up "takes a
 * while" without giving a figure, and that shutdown takes approximately 5 minutes.
 * TODO(łukasz): confirm a typical start-up duration so the page can state one.
 */
const DEMO_BOOT_MS = 4000;
const DEMO_SHUTDOWN_MS = 5000;

const STATES = {
  off: {
    knob: "OFF",
    notReady: false,
    ready: false,
    screen: "STOPPED",
    caption: "Device off. Neither indicator is lit.",
  },
  starting: {
    knob: "ON",
    notReady: true,
    ready: false,
    screen: "STARTING",
    caption: "Automatic start-up sequence running. NOT READY stays lit while the device boots.",
  },
  ready: {
    knob: "ON",
    notReady: false,
    ready: true,
    screen: "RUNNING",
    caption: "Start-up complete. NOT READY is out, READY is lit. The simulation can be set up from the IOS.",
  },
  stopping: {
    knob: "OFF",
    notReady: true,
    ready: false,
    screen: "STOPPING",
    caption: "Shutdown sequence running. The indicator changed to NOT READY immediately and stays lit until the sequence completes.",
  },
};

export default function StartingPanelDemo() {
  const [state, setState] = useState("off");
  const timer = useRef(null);

  const clear = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };
  useEffect(() => clear, []);

  const turn = useCallback(position => {
    clear();
    if (position === "ON" && (state === "off" || state === "stopping")) {
      setState("starting");
      timer.current = setTimeout(() => setState("ready"), DEMO_BOOT_MS);
    } else if (position === "OFF" && (state === "ready" || state === "starting")) {
      setState("stopping");
      timer.current = setTimeout(() => setState("off"), DEMO_SHUTDOWN_MS);
    }
  }, [state]);

  const s = STATES[state];
  const busy = state === "starting" || state === "stopping";

  return (
    <div className={styles.wrap}>
      <div className={styles.panels}>
        {/* ---- physical plate, FCOM fig. 2.2c ---- */}
        <figure className={styles.figure}>
          <svg viewBox="0 0 320 130" className={styles.plate} role="img"
               aria-label={`Starting panel. Knob at ${s.knob}. NOT READY ${s.notReady ? "lit" : "out"}, READY ${s.ready ? "lit" : "out"}.`}>
            <rect x="2" y="2" width="316" height="126" rx="6" className={styles.plateBody} />
            <line x1="18" y1="24" x2="112" y2="24" className={styles.rule} />
            <text x="160" y="28" className={styles.plateLabel}>SIMULATOR</text>
            <line x1="208" y1="24" x2="302" y2="24" className={styles.rule} />

            {/* NOT READY lamp */}
            <rect x="20" y="50" width="86" height="34" rx="4"
                  className={`${styles.lamp} ${s.notReady ? styles.lampRedOn : styles.lampOff}`} />
            <text x="63" y="71" className={`${styles.lampText} ${s.notReady ? styles.lampTextOn : ""}`}>NOT READY</text>

            {/* rotary knob */}
            <text x="132" y="58" className={styles.knobMark}>OFF</text>
            <text x="188" y="58" className={styles.knobMark}>ON</text>
            <circle cx="160" cy="84" r="24" className={styles.knobBody} />
            <line x1="160" y1="84" x2={s.knob === "ON" ? 178 : 142} y2="68" className={styles.knobPointer} />
            <circle cx="160" cy="84" r="4" className={styles.knobHub} />

            {/* READY lamp */}
            <rect x="214" y="50" width="86" height="34" rx="4"
                  className={`${styles.lamp} ${s.ready ? styles.lampGreenOn : styles.lampOff}`} />
            <text x="257" y="71" className={`${styles.lampText} ${s.ready ? styles.lampTextOn : ""}`}>READY</text>
          </svg>
          <figcaption>Starting panel — IOS wall, above the IOS Lights panel</figcaption>
        </figure>

        {/* ---- touchscreen, FCOM figs. 2 and 3 ---- */}
        <figure className={styles.figure}>
          <div className={styles.screen}>
            <div className={styles.screenTop}>
              <span>Systems power</span>
              <span className={styles.screenTemp}>—</span>
            </div>
            <div className={`${styles.screenState} ${busy ? styles.screenStateBusy : ""}`}>{s.screen}</div>
            {state === "stopping" && (
              <div className={styles.screenHint}>Wait for systems shutdown…</div>
            )}
            {state === "starting" && (
              <div className={styles.screenHint}>Automatic start-up in progress…</div>
            )}
            <div className={styles.screenButtons}>
              <span className={styles.screenBtn}>Flight in progress</span>
              <span className={styles.screenBtn}>End Session &amp; Logout</span>
            </div>
          </div>
          <figcaption>Touchscreen state. The virtual shutdown button is a long press.</figcaption>
        </figure>
      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.control} onClick={() => turn("ON")}
                disabled={state === "ready" || state === "starting"}>
          Turn knob to ON
        </button>
        <button type="button" className={styles.control} onClick={() => turn("OFF")}
                disabled={state === "off" || state === "stopping"}>
          Turn knob to OFF
        </button>
        <button type="button" className={styles.controlMuted} onClick={() => { clear(); setState("off"); }}>
          Reset
        </button>
      </div>

      <p className={styles.caption}>{s.caption}</p>
      <p className={styles.disclaimer}>
        Demonstration only. The sequence follows the device, but the timing is compressed: on the device
        start-up takes several minutes and shutdown approximately five. The demonstration does not command
        the simulator.
      </p>
    </div>
  );
}
