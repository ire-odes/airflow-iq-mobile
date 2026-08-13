import Icon from "./Icon";
import { getRangeStatus } from "../lib/metrics";

export default function MetricCard({ metric, stats, pct, onClick }) {
  const dec = metric.decimals ?? 1;
  const avg = stats?.avg;
  const min = stats?.min;
  const max = stats?.max;

  const isUp = pct != null && pct >= 0;
  const outOfRange = getRangeStatus(avg, metric.normalRange) !== "normal";

  // A rise isn't inherently bad, so the trend chip stays neutral-toned and
  // only the arrow direction carries meaning.
  const trendColor = isUp ? "#f59e0b" : "#45B7D1";

  return (
    <button
      className="metric-card"
      onClick={onClick}
      title={
        outOfRange
          ? `${metric.label} — outside normal range (${metric.normalRange[0]}–${metric.normalRange[1]}${metric.unit.trim()})`
          : `${metric.label} — click for detail`
      }
    >
      {outOfRange && <span className="metric-alert" />}

      <div className="metric-card-top">
        <span className="metric-icon"><Icon name={metric.icon} size={15} /></span>
        <span className="metric-label truncate">{metric.label}</span>
        {pct != null && (
          <span
            className="metric-pct"
            style={{
              color: trendColor,
              background: `color-mix(in srgb, ${trendColor} 13%, transparent)`,
            }}
          >
            <Icon name={isUp ? "trending-up" : "trending-down"} size={10} />
            {Math.abs(pct).toFixed(1)}%
          </span>
        )}
      </div>

      <div className="metric-value-row">
        <div className="metric-value">{avg != null ? avg.toFixed(dec) : "—"}</div>
        <div className="metric-unit">
          {metric.unit.trim()}
          <span style={{ opacity: 0.75, fontWeight: 500 }}> avg</span>
        </div>
      </div>

      <div className="metric-minmax">
        <div className="metric-minmax-cell">
          <div className="metric-minmax-label">MIN</div>
          <div className="metric-minmax-value">{min != null ? min.toFixed(dec) : "—"}</div>
        </div>
        <div className="metric-minmax-div" />
        <div className="metric-minmax-cell">
          <div className="metric-minmax-label">MAX</div>
          <div className="metric-minmax-value">{max != null ? max.toFixed(dec) : "—"}</div>
        </div>
      </div>
    </button>
  );
}

export function MetricCardSkeleton() {
  return (
    <div className="card" style={{ minHeight: 152, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="skel" style={{ width: 28, height: 28, borderRadius: 8 }} />
      <div className="skel" style={{ width: "55%", height: 10, marginTop: "auto" }} />
      <div className="skel" style={{ width: "42%", height: 28 }} />
      <div className="skel" style={{ width: "100%", height: 32, borderRadius: 8 }} />
    </div>
  );
}
