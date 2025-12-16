import { CSSProperties, useEffect, useMemo, useState } from "react";

import { EventsOff, EventsOn } from "../wailsjs/runtime/runtime";
import { SendFrame, StartCAN, StopCAN } from "../wailsjs/go/main/App";

type CANFrameEvent = {
  timestamp: string;
  interface: string;
  id: number;
  extended: boolean;
  remote: boolean;
  dlc: number;
  data: number[];
};

export default function CanPage() {
  const [iface, setIface] = useState("vcan0");
  const [filterIdText, setFilterIdText] = useState("");
  const [frames, setFrames] = useState<CANFrameEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<"starting" | "stopping" | null>(null);

  function pushError(msg: unknown) {
    const text = String(msg);
    setErrors((prev) => (prev[0] === text ? prev : [text, ...prev].slice(0, 10)));
  }

  useEffect(() => {
    const onFrame = (payload: CANFrameEvent) => {
      setFrames((prev) => [payload, ...prev].slice(0, 100));
    };
    const onError = (msg: string) => {
      pushError(msg);
    };

    EventsOn("can:frame", onFrame);
    EventsOn("can:error", onError);

    return () => {
      EventsOff("can:frame");
      EventsOff("can:error");
    };
  }, []);

  const filter = useMemo(() => parseHexID(filterIdText), [filterIdText]);
  const filteredFrames = useMemo(() => {
    if (filter.kind === "none") return frames;
    if (filter.kind === "invalid") return [];
    return frames.filter((f) => f.id === filter.id);
  }, [frames, filter]);

  async function start() {
    setErrors([]);
    setBusy("starting");
    try {
      await StartCAN(iface);
      setConnected(true);
    } catch (e: any) {
      setConnected(false);
      pushError(e?.message ?? e);
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stopping");
    try {
      await StopCAN();
    } catch (e: any) {
      pushError(e?.message ?? e);
    } finally {
      setConnected(false);
      setBusy(null);
    }
  }

  async function sendTestFrame() {
    try {
      await SendFrame(0x123, [0x01, 0x02, 0x03], false);
    } catch (e: any) {
      pushError(e?.message ?? e);
    }
  }

  const disabled = busy !== null;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.title}>SocketCAN Monitor</div>
        <div style={styles.subtitle}>Wails v2 + Go (go.einride.tech/can) + React</div>
      </div>

      <div style={styles.controls}>
        <div style={styles.field}>
          <label style={styles.label}>Interface</label>
          <input
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            disabled={connected || disabled}
            placeholder="vcan0"
            style={styles.input}
          />
        </div>

        <button onClick={start} disabled={connected || disabled || !iface.trim()} style={styles.button}>
          Start
        </button>
        <button onClick={stop} disabled={!connected || disabled} style={styles.button}>
          Stop
        </button>
        <button onClick={sendTestFrame} disabled={!connected || disabled} style={styles.button}>
          Send test frame
        </button>

        <div style={styles.field}>
          <label style={styles.label}>Filter ID (hex, optional)</label>
          <input
            value={filterIdText}
            onChange={(e) => setFilterIdText(e.target.value)}
            placeholder="123 / 0x123 / 18FF50E5"
            style={styles.input}
          />
          {filter.kind === "invalid" ? (
            <div style={styles.inlineError}>Invalid hex ID</div>
          ) : (
            <div style={styles.inlineHint}>
              {filter.kind === "id" ? `Filtering on 0x${filter.hex}` : " "}
            </div>
          )}
        </div>
      </div>

      {errors.length > 0 ? (
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>Errors</div>
          {errors.map((e, idx) => (
            <div key={idx} style={styles.errorLine}>
              {e}
            </div>
          ))}
        </div>
      ) : null}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead style={styles.thead}>
            <tr>
              <th style={styles.th}>Timestamp</th>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>DLC</th>
              <th style={styles.th}>Data</th>
            </tr>
          </thead>
          <tbody>
            {filteredFrames.length === 0 ? (
              <tr>
                <td style={styles.tdEmpty} colSpan={5}>
                  {filter.kind === "invalid" ? "Fix Filter ID to show frames." : "No frames yet."}
                </td>
              </tr>
            ) : (
              filteredFrames.map((f, idx) => (
                <tr key={idx} style={styles.tr}>
                  <td style={styles.td}>{formatTimestamp(f.timestamp)}</td>
                  <td style={styles.td}>{formatID(f.id, f.extended)}</td>
                  <td style={styles.td}>{f.extended ? "EXT" : "STD"}</td>
                  <td style={styles.td}>{f.dlc}</td>
                  <td style={{ ...styles.td, whiteSpace: "pre" }}>{formatData(f.data)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={styles.footer}>
        Showing <b>{filteredFrames.length}</b> / {frames.length} frames (keeps last 100).
      </div>
    </div>
  );
}

type ParsedHexID =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "id"; id: number; hex: string };

function parseHexID(input: string): ParsedHexID {
  const raw = input.trim();
  if (!raw) return { kind: "none" };
  const s = raw.toLowerCase().startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]+$/.test(s)) return { kind: "invalid" };
  const id = Number.parseInt(s, 16);
  if (!Number.isFinite(id)) return { kind: "invalid" };
  return { kind: "id", id, hex: s.toUpperCase() };
}

function formatID(id: number, extended: boolean): string {
  const width = extended ? 8 : 3;
  return `0x${id.toString(16).toUpperCase().padStart(width, "0")}`;
}

function formatData(data: number[]): string {
  return data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { hour12: false });
}

const styles: Record<string, CSSProperties> = {
  page: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "18px 18px 24px",
    textAlign: "left",
  },
  header: {
    marginBottom: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
  },
  subtitle: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 2,
  },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "flex-end",
    padding: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 8,
    background: "rgba(255,255,255,0.04)",
    marginBottom: 12,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 220,
  },
  label: {
    fontSize: 12,
    opacity: 0.85,
  },
  input: {
    height: 34,
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.25)",
    color: "white",
    padding: "0 10px",
    outline: "none",
    fontFamily: "inherit",
  },
  button: {
    height: 34,
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.10)",
    color: "white",
    padding: "0 12px",
    cursor: "pointer",
    fontWeight: 600,
  },
  inlineHint: {
    fontSize: 12,
    opacity: 0.7,
    minHeight: 14,
  },
  inlineError: {
    fontSize: 12,
    color: "#FF7A7A",
    minHeight: 14,
  },
  errorBox: {
    marginBottom: 12,
    padding: 12,
    borderRadius: 8,
    background: "rgba(120, 20, 20, 0.55)",
    border: "1px solid rgba(255, 90, 90, 0.8)",
  },
  errorTitle: {
    fontWeight: 700,
    marginBottom: 8,
  },
  errorLine: {
    fontFamily: "monospace",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    opacity: 0.95,
  },
  tableWrap: {
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.14)",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: "monospace",
    fontSize: 12,
  },
  thead: {
    background: "rgba(255,255,255,0.08)",
  },
  th: {
    textAlign: "left",
    padding: "10px 10px",
    fontWeight: 700,
    borderBottom: "1px solid rgba(255,255,255,0.10)",
  },
  tr: {
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  td: {
    padding: "8px 10px",
    verticalAlign: "top",
  },
  tdEmpty: {
    padding: 12,
    opacity: 0.8,
  },
  footer: {
    marginTop: 10,
    fontSize: 12,
    opacity: 0.75,
  },
};
