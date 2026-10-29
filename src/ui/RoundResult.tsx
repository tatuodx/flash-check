import type { RoundResult } from "../domain/types";

const ACTION_SUFFIX = new Set(["PERFECT", "GOOD", "LATE", "EARLY"]);

export function headline(r: RoundResult): string {
  return ACTION_SUFFIX.has(r.label) ? `${r.label} ${r.playerAction}` : r.label;
}

export function RoundResultOverlay({ result }: { result: RoundResult }) {
  const good = result.survived && result.decisionScore >= 400;
  return (
    <div className={`round-result ${result.survived ? (good ? "good" : "meh") : "bad"}`}>
      <div className="headline">{headline(result)}</div>
      {result.reactionTimeMs !== undefined && <div>Reaction {result.reactionTimeMs} ms</div>}
      {result.playerAction !== result.expectedAction && <div className="expected">正解: {result.expectedAction}</div>}
      <div className="points">+{result.totalScore}</div>
      {result.csCount > 0 && (
        <div className="cs-line">
          CS {result.csCount}
          {result.csCannon > 0 && ` (砲台 ${result.csCannon})`} +{result.csScore}
        </div>
      )}
    </div>
  );
}
