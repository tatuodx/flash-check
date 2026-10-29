import { useState } from "react";

export function Title({ onStart }: { onStart: (seed: string) => void }) {
  const [seed, setSeed] = useState("");
  return (
    <div className="screen title">
      <h1>FLASH CHECK</h1>
      <p className="tagline">敵の動きを見極めて、Flash / 移動 / 待機を判断せよ</p>

      <div className="controls">
        <div><kbd>右クリック</kbd> 移動 / 攻撃範囲内の敵ミニオンなら攻撃 (とどめでCSボーナス 小 +20 / 砲台 +50)</div>
        <div><kbd>F</kbd> カーソル方向へFlash (1ラウンド1回)</div>
      </div>
      <ul className="hints">
        <li><span className="swatch red" /> 赤い領域だけが実際の攻撃判定</li>
        <li><span className="swatch orange" /> 橙は照準中 (Lockされると赤に変わる)</li>
        <li><span className="swatch yellow" /> 黄色の詠唱は本命とは限らない</li>
      </ul>

      <form
        className="start"
        onSubmit={(e) => {
          e.preventDefault();
          onStart(seed.trim());
        }}
      >
        <label>
          Seed
          <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="空欄でランダム" maxLength={32} />
        </label>
        <button type="submit" className="primary">GAME START</button>
      </form>

      <div className="future">Daily Challenge / Ranking — coming soon</div>
    </div>
  );
}
