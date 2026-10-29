import { useState } from "react";
import type { GameResult } from "../domain/types";
import { FinalResult } from "../ui/FinalResult";
import { GameScreen } from "../ui/GameScreen";
import { Title } from "../ui/Title";

type Screen = { kind: "title" } | { kind: "game"; seed: string; runId: number } | { kind: "final"; result: GameResult };

/** UI層のSeed生成のみ。ゲームロジックは常にSeeded RNGを使う */
export function randomSeed(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0].toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "title" });
  const [runId, setRunId] = useState(0);

  const start = (seed: string) => {
    setRunId((n) => n + 1);
    setScreen({ kind: "game", seed, runId: runId + 1 });
  };

  switch (screen.kind) {
    case "title":
      return <Title onStart={(seed) => start(seed || randomSeed())} />;
    case "game":
      return (
        <GameScreen
          key={screen.runId}
          seed={screen.seed}
          onComplete={(result) => setScreen({ kind: "final", result })}
          onQuit={() => setScreen({ kind: "title" })}
        />
      );
    case "final":
      return (
        <FinalResult
          result={screen.result}
          onPlayAgain={() => start(randomSeed())}
          onRetrySeed={() => start(screen.result.seed)}
          onTitle={() => setScreen({ kind: "title" })}
        />
      );
  }
}
