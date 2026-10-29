import { GAME_CONFIG, championName } from "../config/balance";
import type { GameResult } from "../domain/types";
import { headline } from "./RoundResult";

interface Props {
  result: GameResult;
  onPlayAgain: () => void;
  onRetrySeed: () => void;
  onTitle: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function FinalResult({ result, onPlayAgain, onRetrySeed, onTitle }: Props) {
  const n = result.rounds.length;
  return (
    <div className="screen final">
      <h1>FLASH CHECK</h1>
      <div className="total">
        TOTAL <strong>{result.totalScore.toLocaleString()}</strong>
      </div>
      <div className="breakdown">
        本命 {result.mainScore.toLocaleString()} / {result.maxScore.toLocaleString()} + CS {result.csScore.toLocaleString()}
      </div>

      <table className="rounds">
        <thead>
          <tr>
            <th>Round</th>
            <th>Result</th>
            <th>Score</th>
            <th>相手</th>
            <th>Encounter</th>
            <th>Action / 正解</th>
            <th>Reaction</th>
            <th>CS</th>
          </tr>
        </thead>
        <tbody>
          {result.rounds.map((r) => (
            <tr key={r.roundIndex} className={r.survived ? "" : "hit"}>
              <td>R{pad(r.roundIndex + 1)}</td>
              <td>{headline(r)}</td>
              <td className="num">{r.totalScore}</td>
              <td>
                {championName(r.champion)}
                {r.ganker === "kritz" && ` + ${GAME_CONFIG.gankers.kritz.name}`}
              </td>
              <td className="enc">
                {r.encounterId} {r.encounterName}
              </td>
              <td>
                {r.playerAction} / {r.expectedAction}
              </td>
              <td className="num">{r.reactionTimeMs !== undefined ? `${r.reactionTimeMs} ms` : "-"}</td>
              <td className="num">{r.csCount > 0 ? `${r.csCount} (+${r.csScore})` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="stats">
        <dt>Average Reaction</dt>
        <dd>{result.averageReactionMs !== undefined ? `${result.averageReactionMs} ms` : "-"}</dd>
        <dt>Best Reaction</dt>
        <dd>{result.bestReactionMs !== undefined ? `${result.bestReactionMs} ms` : "-"}</dd>
        <dt>Perfect</dt>
        <dd>
          {result.perfectCount} / {n}
        </dd>
        <dt>Hit</dt>
        <dd>
          {result.hitCount} / {n}
        </dd>
        <dt>Wasted Flash</dt>
        <dd>{result.wastedFlashCount}</dd>
        <dt>CS</dt>
        <dd>{result.csCount}</dd>
        <dt>Seed</dt>
        <dd>{result.seed}</dd>
      </dl>

      <div className="buttons">
        <button className="primary" onClick={onPlayAgain}>PLAY AGAIN</button>
        <button onClick={onRetrySeed}>RETRY SAME SEED</button>
        <button onClick={onTitle}>TITLE</button>
      </div>
    </div>
  );
}
