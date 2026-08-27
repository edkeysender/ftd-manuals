/**
 * Working model of the simulator starting panel, software 2.0.1.
 *
 * Built to section F.7 of the starting panel manual. It behaves like the real screen:
 * log in with any four digits, start, restart and stop with a press and hold, open the
 * process list, pull the two drawers, and simulate either emergency stop.
 *
 * Sequence step names and counts are the configured ones (F.7 §7.5.5). Step timing is
 * compressed — the real sequences take about 66 s, 75 s and 63 s — and the page says so.
 * Nothing here commands a simulator.
 *
 * SSR-safe: no DOM access during render, and every timer is cleared on unmount.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import styles from "./StartingPanelDemo.module.css";

/* ---------------------------------------------------------------- sequences */
// F.7 §7.5.5. Steps that share a code in the source occupy the counter positions it gives.
const START_STEPS = [
  "Update sequence state", "Update sequence state",
  "Power on relay 1", "Wait after relay 1",
  "Power on relay 2", "Wait after relay 2",
  "Power on relay 3", "Wait after relay 3",
  "Power on relay 4", "Wait for power stabilization",
  "Wake-on-LAN Avionics", "Wake-on-LAN IOS", "Wake-on-LAN Display",
  "Wait after wake-on-LAN", "Wait for SIM ready", "Wait for CLS service state",
  "Set sequence state to ready", "Set sequence state to ready",
];
const SHUTDOWN_STEPS = [
  "Update sequence state", "Update sequence state",
  "Shutting down IOS", "Shutting down Display", "Shutting down Avionics",
  "Wait for systems shutdown",
  "Shutting down relay 1", "Shutting down relay 2", "Shutting down relay 3",
  "Wait for power shutdown", "Shutting down relay 4", "Wait for power shutdown",
  "Restoring power", "Changing status state", "Changing status state",
];
const RESTART_STEPS = [
  "Update sequence state", "Update sequence state",
  "Shutting down IOS", "Shutting down Display", "Shutting down Avionics",
  "Wait for systems shutdown",
  "Wake-on-LAN Avionics", "Wake-on-LAN IOS", "Wake-on-LAN Display",
  "Wait after wake-on-LAN", "Wait for SIM ready", "Wait for CLS service state",
  "Set sequence state to ready", "Set sequence state to ready",
];

const STEP_MS = 260;      // compressed; see F.7 §7.5 for real times
const HOLD_MS = 3000;     // the real guard time for restart and stop

// F.7 §7.4
const STATE_META = {
  STOPPED:    { seq: 0, tone: "stopped" },
  STARTING:   { seq: 1, tone: "busy" },
  RUNNING:    { seq: 4, tone: "running" },
  STOPPING:   { seq: 2, tone: "busy" },
  RESTARTING: { seq: 3, tone: "busy" },
  ERROR:      { seq: 5, tone: "error" },
};

// F.7 §7.8. Site-specific; this is the configuration the manual documents.
const COMPUTERS = [
  { ip: "70.84.68.10", procs: [{ name: "ProSimIOS", dot: "on" }] },
  { ip: "70.84.68.11", procs: [
    { name: "ImmersiveDisplayPRO", dot: "on" },
    { name: "Prepar3D", dot: "on" },
    { name: "ControlLoadingSystem", dot: "on" },
  ] },
  { ip: "70.84.68.12", procs: [
    { name: "CDU_CPT", dot: "off" },
    { name: "ProSimAudio2", dot: "pending" },
  ] },
];

const LOADS = ["Development Mode", "Maintenance Load", "QTG Mode"];

export default function StartingPanelDemo() {
  const [state, setState] = useState("STOPPED");
  const [step, setStep] = useState(null);          // { i, total, name }
  const [loggedIn, setLoggedIn] = useState(false);
  const [pin, setPin] = useState("");
  const [screen, setScreen] = useState("main");    // main | processes
  const [drawer, setDrawer] = useState(null);      // null | load | volume
  const [load, setLoad] = useState(null);
  const [fip, setFip] = useState(false);
  const [cls, setCls] = useState(false);           // CLS banner shown
  const [dark, setDark] = useState(false);         // TOTAL stop: panel unpowered
  const [hold, setHold] = useState(null);          // { which, pct }
  const [brightness, setBrightness] = useState(80);
  const [volume, setVolume] = useState(60);

  const seqTimer = useRef(null);
  const holdTimer = useRef(null);

  const clearAll = () => {
    if (seqTimer.current) { clearInterval(seqTimer.current); seqTimer.current = null; }
    if (holdTimer.current) { clearInterval(holdTimer.current); holdTimer.current = null; }
  };
  useEffect(() => clearAll, []);

  /** Runs a sequence, then settles into `endState`. */
  const runSequence = useCallback((steps, runningState, endState) => {
    clearAll();
    setState(runningState);
    setStep({ i: 1, total: steps.length, name: steps[0] });
    let i = 1;
    seqTimer.current = setInterval(() => {
      i += 1;
      if (i > steps.length) {
        clearAll();
        setStep(null);
        setState(endState);
        return;
      }
      setStep({ i, total: steps.length, name: steps[i - 1] });
    }, STEP_MS);
  }, []);

  /* ---- press and hold guard for restart and stop (F.7 §7.5.2) ---- */
  const beginHold = which => {
    if (state !== "RUNNING" || cls) return;
    clearAll();
    const started = Date.now();
    setHold({ which, pct: 0 });
    holdTimer.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - started) / HOLD_MS) * 100);
      if (pct >= 100) {
        clearAll();
        setHold(null);
        if (which === "stop") runSequence(SHUTDOWN_STEPS, "STOPPING", "STOPPED");
        else runSequence(RESTART_STEPS, "RESTARTING", "RUNNING");
      } else {
        setHold({ which, pct });
      }
    }, 40);
  };
  const endHold = () => { clearAll(); setHold(null); };   // released early: cancelled

  const pressDigit = d => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) { setLoggedIn(true); setPin(""); }
  };

  const totalStop = () => { clearAll(); setDark(true); setStep(null); };
  const wake = () => {
    // A TOTAL stop is an uncontrolled power cut: everything comes up from cold.
    setDark(false); setState("STOPPED"); setLoggedIn(false); setPin("");
    setScreen("main"); setDrawer(null); setCls(false); setStep(null); setFip(false);
  };

  const clsStop = () => {
    if (dark) return;
    clearAll(); setStep(null); setCls(true);
    if (state === "STARTING" || state === "STOPPING" || state === "RESTARTING") setState("ERROR");
  };

  const reset = () => {
    setCls(false);
    if (state === "ERROR") setState("STOPPED");
  };

  const meta = STATE_META[state];
  const locked = !loggedIn;
  const busy = meta.tone === "busy";
  const controlsBlocked = cls || busy;

  return (
    <div className={styles.wrap}>
      <div className={styles.layout}>
        {/* ---------------- station ---------------- */}
        <div className={styles.station}>
          <div className={styles.estopBlock}>
            <div className={styles.estopLabel}>EMERGENCY STOP</div>
            <div className={styles.estopRow}>
              <div className={styles.estopCell}>
                <button type="button" className={styles.estop} onClick={totalStop}
                        aria-label="Simulate TOTAL emergency stop" title="Cuts every supply, including this panel" />
                <span className={styles.estopName}>TOTAL</span>
              </div>
              <div className={styles.estopCell}>
                <button type="button" className={styles.estop} onClick={clsStop}
                        aria-label="Simulate CLS emergency stop" title="Removes power from the control loading system only" />
                <span className={styles.estopName}>CLS</span>
              </div>
            </div>
          </div>

          {/* ---------------- touchscreen ---------------- */}
          <div className={styles.bezel}>
            {dark ? (
              <button type="button" className={styles.dark} onClick={wake}>
                <span className={styles.darkHint}>Panel unpowered — touch to restore</span>
              </button>
            ) : (
              <div className={styles.screen} style={{ filter: `brightness(${0.55 + brightness / 220})` }}>
                <div className={styles.statusBar}>
                  <span>27.08.2026 12:50 UTC</span>
                  <span>27.5 °C</span>
                </div>

                <button type="button" className={styles.chevronTop}
                        onClick={() => setDrawer(drawer === "load" ? null : "load")}
                        aria-label="Load and mode drawer">▾</button>

                {drawer === "load" && (
                  <div className={styles.drawerTop}>
                    <div className={styles.loadRow}>
                      {LOADS.slice(0, 2).map(l => (
                        <button key={l} type="button"
                                className={`${styles.loadBtn} ${load === l ? styles.loadActive : ""}`}
                                onClick={() => setLoad(load === l ? null : l)}>{l}</button>
                      ))}
                    </div>
                    <button type="button"
                            className={`${styles.loadBtn} ${load === LOADS[2] ? styles.loadActive : ""}`}
                            onClick={() => setLoad(load === LOADS[2] ? null : LOADS[2])}>{LOADS[2]}</button>
                  </div>
                )}

                {screen === "processes" ? (
                  <ProcessList onBack={() => setScreen("main")} />
                ) : (
                  <>
                    {drawer !== "load" && <div className={styles.brand}>FTD.AERO</div>}

                    {locked ? (
                      <Keypad pin={pin} onDigit={pressDigit}
                              onDelete={() => setPin(pin.slice(0, -1))}
                              onClear={() => setPin("")} />
                    ) : (
                      <>
                        {hold && <div className={styles.holdBar}><i style={{ width: `${hold.pct}%` }} /></div>}
                        <div className={styles.buttons}>
                          <button type="button"
                                  className={`${styles.round} ${styles.start}`}
                                  disabled={state !== "STOPPED" || controlsBlocked}
                                  onClick={() => runSequence(START_STEPS, "STARTING", "RUNNING")}
                                  aria-label="Start">⏻</button>
                          <button type="button"
                                  className={`${styles.round} ${styles.restart} ${hold?.which === "restart" ? styles.held : ""}`}
                                  disabled={state !== "RUNNING" || controlsBlocked}
                                  onMouseDown={() => beginHold("restart")} onMouseUp={endHold} onMouseLeave={endHold}
                                  onTouchStart={() => beginHold("restart")} onTouchEnd={endHold}
                                  aria-label="Restart, press and hold">⏻</button>
                          <button type="button"
                                  className={`${styles.round} ${styles.stop} ${hold?.which === "stop" ? styles.held : ""}`}
                                  disabled={state !== "RUNNING" || controlsBlocked}
                                  onMouseDown={() => beginHold("stop")} onMouseUp={endHold} onMouseLeave={endHold}
                                  onTouchStart={() => beginHold("stop")} onTouchEnd={endHold}
                                  aria-label="Stop, press and hold">⏻</button>
                        </div>

                        <button type="button"
                                className={`${styles.stateText} ${styles[meta.tone]}`}
                                onClick={() => state === "RUNNING" && setScreen("processes")}
                                title={state === "RUNNING" ? "Open the process list" : undefined}>
                          {state}
                        </button>
                        {step && <div className={styles.stepLine}>{step.i}/{step.total} {step.name}</div>}

                        {cls && (
                          <div className={styles.clsBanner}>
                            <span>CLS EMERGENCY STOP</span>
                            <button type="button" className={styles.resetBtn} onClick={reset}>RESET</button>
                          </div>
                        )}
                      </>
                    )}

                    <div className={styles.sessionRow}>
                      <button type="button"
                              className={`${styles.sessionBtn} ${fip ? styles.sessionOn : ""}`}
                              disabled={locked} onClick={() => setFip(!fip)}>Flight in progress</button>
                      <button type="button" className={styles.sessionBtn} disabled={locked}
                              onClick={() => { setLoggedIn(false); setScreen("main"); setDrawer(null); }}>
                        End Session &amp; Logout
                      </button>
                    </div>

                    <div className={styles.sliderRow}>
                      {drawer === "volume" ? (
                        <>
                          <span className={styles.sliderIcon}>🔈</span>
                          <input type="range" min="0" max="100" value={volume}
                                 onChange={e => setVolume(Number(e.target.value))}
                                 className={styles.slider} aria-label="Volume" />
                          <span className={styles.sliderIcon}>🔊</span>
                        </>
                      ) : (
                        <>
                          <span className={styles.sliderIcon}>☼</span>
                          <input type="range" min="0" max="100" value={brightness}
                                 onChange={e => setBrightness(Number(e.target.value))}
                                 className={styles.slider} aria-label="Brightness" />
                          <span className={styles.sliderIcon}>☀</span>
                        </>
                      )}
                    </div>

                    <button type="button" className={styles.chevronBottom}
                            onClick={() => setDrawer(drawer === "volume" ? null : "volume")}
                            aria-label="Volume drawer">▴</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ---------------- side panel ---------------- */}
        <div className={styles.side}>
          <p className={styles.tryTitle}>Try the following</p>
          <ul className={styles.tryList}>
            <li>Enter any four digits — the panel logs in on the fourth.</li>
            <li>Press <strong>Start</strong> and watch the 18-step sequence.</li>
            <li>From RUNNING, hold the centre button for 3 s to restart.</li>
            <li>Touch the word <strong>RUNNING</strong> to open the process list.</li>
            <li>Hold <strong>Stop</strong> for 3 s to run the 15-step shutdown.</li>
            <li>Pull the load and mode drawer down from the top chevron; pull the volume drawer up from the bottom one and watch it take the brightness slider’s place.</li>
          </ul>

          <div className={styles.simRow}>
            <button type="button" className={styles.simCls} onClick={clsStop}>Simulate CLS emergency stop</button>
            <button type="button" className={styles.simTotal} onClick={totalStop}>Simulate TOTAL emergency stop (panel goes dark)</button>
          </div>

          <div className={styles.fipSign}>
            <span>FIP sign on the hall wall</span>
            <span className={`${styles.fipLamp} ${fip ? styles.fipOn : ""}`}>FLIGHT IN PROGRESS</span>
          </div>

          <p className={styles.note}>
            Step timings in the model are compressed. Real sequence times are given above. After a simulated
            CLS stop, press <strong>RESET</strong> in the banner to clear it, as you would on the panel once the
            mushroom head is released. A TOTAL stop blanks the model until you touch the screen, standing in for
            the panel losing power.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- keypad */
function Keypad({ pin, onDigit, onDelete, onClear }) {
  return (
    <div className={styles.keypadWrap}>
      <div className={styles.pinDots}>
        {[0, 1, 2, 3].map(i => (
          <span key={i} className={`${styles.pinDot} ${i < pin.length ? styles.pinDotOn : ""}`} />
        ))}
      </div>
      <div className={styles.keypad}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => (
          <button key={d} type="button" className={styles.key} onClick={() => onDigit(d)}>{d}</button>
        ))}
        <button type="button" className={styles.key} onClick={onDelete} aria-label="Delete last digit">⌫</button>
        <button type="button" className={styles.key} onClick={() => onDigit("0")}>0</button>
        <button type="button" className={styles.key} onClick={onClear} aria-label="Clear entry">C</button>
      </div>
      <div className={styles.keypadHint}>Four digits — logs in automatically</div>
    </div>
  );
}

/* ---------------------------------------------------------------- process list */
function ProcessList({ onBack }) {
  return (
    <div className={styles.processes}>
      <div className={styles.processTop}>
        <button type="button" className={styles.backBtn} onClick={onBack}>BACK</button>
        <span className={styles.infoBtn} title="Software and build information">i</span>
      </div>
      <div className={styles.processScroll}>
        {COMPUTERS.map(c => (
          <div key={c.ip}>
            <div className={styles.ipRow}>
              <span className={styles.ip}>IP: {c.ip}</span>
              <span className={styles.procBtns}>
                <span className={styles.procBtn}>START</span><span className={styles.procBtn}>STOP</span>
              </span>
            </div>
            {c.procs.map(p => (
              <div key={p.name} className={styles.procRow}>
                <span className={`${styles.dot} ${styles[`dot_${p.dot}`]}`} />
                <span className={styles.procName}>{p.name}</span>
                <span className={styles.procBtns}>
                  <span className={`${styles.procBtn} ${p.dot === "pending" ? styles.procBtnDim : ""}`}>START</span>
                  <span className={`${styles.procBtn} ${p.dot === "pending" ? styles.procBtnDim : ""}`}>STOP</span>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.processFoot}>
        <span className={styles.wideBtn}>START ALL</span>
        <span className={styles.wideBtn}>KILL ALL</span>
      </div>
    </div>
  );
}
