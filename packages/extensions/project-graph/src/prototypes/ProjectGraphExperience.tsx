import { useState } from "react";
import type { PanelHostProps } from "@nimbalyst/extension-sdk";
import { ProjectGraphPanel } from "../components/ProjectGraphPanel";
import { PrototypeLab } from "./PrototypeLab";
import "./prototype-shell.css";

export function ProjectGraphExperience({ host }: PanelHostProps) {
  const [legacy, setLegacy] = useState(false);
  const [visitedLegacy, setVisitedLegacy] = useState(false);
  return (
    <div className="pg-experience">
      <div className="pg-experience-switch">
        <strong>Project understanding</strong>
        <span>
          {legacy
            ? "Advanced · legacy graph and state history"
            : "Atlas · Pulse · Evidence Trails"}
        </span>
        <button
          aria-pressed={legacy}
          onClick={() => {
            setVisitedLegacy(true);
            setLegacy((v) => !v);
          }}
        >
          {legacy ? "Return to project views" : "Advanced: legacy graph"}
        </button>
      </div>
      <div className="pg-experience-content">
        <div className="pg-experience-page" hidden={legacy}>
          <PrototypeLab host={host} />
        </div>
        {visitedLegacy && (
          <div className="pg-experience-page" hidden={!legacy}>
            <ProjectGraphPanel host={host} active={legacy} />
          </div>
        )}
      </div>
    </div>
  );
}
