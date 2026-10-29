import { useEffect, useMemo, useRef, useState } from "react";
import { buildEncounterSequence } from "../domain/session";
import type { GameResult } from "../domain/types";
import { GameBridge, type HudState } from "../game/bridge";
import { createGame } from "../game/three/createGame";
import { GameHud } from "./GameHud";
import { RoundResultOverlay } from "./RoundResult";

interface Props {
  seed: string;
  onComplete: (result: GameResult) => void;
  onQuit: () => void;
}

export function GameScreen({ seed, onComplete, onQuit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const encounters = useMemo(() => buildEncounterSequence(seed), [seed]);
  const [hud, setHud] = useState<HudState | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const bridge = new GameBridge();
    const offHud = bridge.on("hud", setHud);
    const offDone = bridge.on("complete", (r) => onCompleteRef.current(r));
    const game = createGame(host.current!, { seed, encounters, bridge });
    return () => {
      offHud();
      offDone();
      game.destroy();
    };
  }, [seed, encounters]);

  return (
    <div className="screen game">
      {hud && <GameHud hud={hud} seed={seed} />}
      <div className="stage">
        <div ref={host} className="canvas-host" onContextMenu={(e) => e.preventDefault()} />
        {hud?.phase === "INTRO" && (
          <div className="intro">
            ROUND {hud.roundIndex + 1}
            <div className="intro-vs">VS {hud.opponent}</div>
          </div>
        )}
        {hud?.lastResult && (hud.phase === "RESULT" || hud.phase === "RESOLUTION") && (
          <RoundResultOverlay result={hud.lastResult} />
        )}
      </div>
      <button className="quit" onClick={onQuit}>QUIT</button>
    </div>
  );
}
