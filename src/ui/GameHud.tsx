import type { HudState } from "../game/bridge";

export function GameHud({ hud, seed }: { hud: HudState; seed: string }) {
  return (
    <div className="hud">
      <div>
        Round <strong>{Math.min(hud.roundIndex + 1, hud.roundCount)}</strong> / {hud.roundCount}
      </div>
      <div className="opponent">VS {hud.opponent}</div>
      <div>
        Score <strong>{hud.totalScore.toLocaleString()}</strong>
      </div>
      <div className={hud.flashReady ? "flash ready" : "flash used"}>Flash {hud.flashReady ? "READY" : "USED"}</div>
      <div className="cs">
        CS <strong>{hud.roundCs}</strong>
        {hud.roundCsScore > 0 && <span className="cs-bonus"> +{hud.roundCsScore}</span>}
      </div>
      <div className="combo">{hud.combo >= 2 ? `${hud.combo} COMBO` : ""}</div>
      <div className="seed">seed {seed}</div>
    </div>
  );
}
