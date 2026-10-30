# Flash Check

Midレーン状況で敵アクションを認識し、Flash / 移動 / 待機を判断する10ラウンド制ブラウザゲーム (MVP)。
仕様: `flash-check-spec/` (00〜09)。開発の知見・決定事項・残作業は [docs/DEVELOPMENT_NOTES.md](docs/DEVELOPMENT_NOTES.md)。

## 起動

```sh
npm install
npm run dev      # http://localhost:5173 (WebGL必須)
npm test         # unit / integration tests (vitest)
npm run build    # typecheck + production build
```

操作: 右クリック=移動 (攻撃範囲内の敵ミニオン上なら攻撃) / F=カーソル方向へFlash (1ラウンド1回)

## 構成

```text
src/
  config/balance.ts          全バランス値 (Magic numberはここへ集約)
  domain/                    描画非依存の純粋ロジック
    rng.ts                   Seeded RNG (Math.random不使用)
    flash.ts / geometry.ts   Flash Clamp, 当たり判定 (capsule / circle)
    fieldLayout.ts           陰・ブッシュの配置と視界判定 (反応時間の基準にも使う)
    simulation/              1ラウンドの決定論的シミュレーション (固定サブステップ, swept判定)
    encounters/              定義 (data) / generator / validation / deck選択
    scoring.ts               行動分類・Decision/Timing/Execution採点
    aggregate.ts             Final Result集計
    session.ts               Seed -> 10ラウンドのEncounter列
  game/                      描画・入力層 (Three.js)
    systems/RoundSystem.ts   INTRO→NEUTRAL→THREAT→RESOLUTION→RESULT→COMPLETE 状態機械
    three/createGame.ts      斜め上の固定カメラ、入力 (地面へのレイキャスト, performance.now())、描画ループ
    three/field.ts           立体フィールド (Midレーン・上下の川・川口のブッシュ・陰のジャングル壁・タワー)
    three/models.ts          コード生成のデフォルメ・ローポリモデル (キャラ・ミニオン・タワー)
    three/GameView.ts        RoundSimulation → シーン反映 (危険領域は地面オーバーレイ、弾等は立体)
    three/pools.ts           毎フレーム描く図形のMeshプール
  ui/                        React: Title / HUD / Round Result / Final Result
```

## 実装済みEncounter (MVP-1 + MVP-2, 13種)

ENC-001, 002, 003, 004, 008, 010, 012, 013, 015, 017, 020, 021, 024 (ENC-006/016 の標準のガンクは廃止し、ガンクはクリッツブランクの7問)

## 仕様上の未定義点で決めたこと

| 項目 | 決定 |
| --- | --- |
| WAIT正解ラウンドでFlash未使用 | 1000点 (GOOD HOLD) |
| WAIT正解ラウンドでFlash使用 | Decision 100のみ (WASTED FLASH) |
| 期待行動と違うが生存 | Decision 100、Timing/Executionは通常計算 |
| Timingカーブ | excellent以下400 → good 300 → late 150 を線形補間、late超50、被弾0 |
| Lock型 (ENC-013/020) のLock前行動 | Timing半減 (EARLY) |
| 被弾 | 0点。本命認識後のFlashで被弾した場合は WRONG DIRECTION 表示 |
| ラウンド終了 | 被弾時は即時、それ以外は生成時のroundDuration (本命解決+0.35〜0.65s) |
| Flash後の移動命令 | Flashで移動目的地はクリアされる |
| 視覚Cue | 赤=実Hitbox / 橙=照準中(Lock前) / 黄=詠唱 (Fakeも出す) / 白=Gap・踏み込み |
| Validation | Flash問題は200ms反応で安全なFlash先が存在すること。300ms反応で歩いて避けられる生成は再抽選。Move問題は350ms反応で歩いて避けられること |
| 実行時の鏡像化 | Neutral中に画面端へ寄った場合、Gap/広い側が画面外になる問題はTelegraph表示前に左右/上下を反転 |
| Seed | Title画面で入力可 (空欄でランダム)。Final Resultに表示、同Seedで再挑戦可 |
| 相手の種類 | 標準の敵・「米倉」(ヨネをモチーフにしたオリジナルキャラ)・「アリ」(アーリをモチーフにしたオリジナルキャラ) をラウンドごとに抽選する (米倉45%・アリ45%・標準10%)。米倉とアリは自分の技の問題とガンクしか出さず、標準の技 (円・横なぎの壁など) は撃たない。米倉は Q3 (突風の突進) / R (一閃) / E (踏み込み → 本命 → 体へ戻る) を使い、Q1/Q2 は演出のみ。アリは E (魅了、範囲は表示しない) を撃ち、最大3回の R (当たり判定のない短いダッシュ) で接近や後退をしてタイミングを読みにくくする |
| ガンク | ガンクは川の陰から3体目の敵「クリッツブランク」(ブリッツクランクをモチーフにしたオリジナルキャラ) が来る問題だけ。Q (グラブ) は範囲を表示せず、当たると引き寄せられる。W (加速) で近づくだけで撃たないフェイクもある。終盤には、レーンの相手のフェイク直後のQ、相手の技との挟み撃ち、長く様子を見てからのQ、陰からの近距離Q も出る |
| 相手チャンピオン | ランダムに歩くが、自分から200〜330の距離・正面側・レーン内を保つ。本命の詠唱前とFake詠唱中は立ち止まる |
| ミニオン / CS | 味方・敵とも小2体 + 砲台1体がレーン中央で戦う。攻撃範囲内の敵ミニオンを右クリックで攻撃し、とどめを刺すとCSボーナス (小 +20 / 砲台 +50)。1000点とは別枠で加算 |
| 視界 | 陰とブッシュ内は視界なし (自分が入ったブッシュは見える)。敵ユニットと視界外の攻撃を隠し、反応時間は本命が視界に入った瞬間から測る |
| 描画 | Three.jsの3D。ゲーム座標は2Dのまま (1000x600の平面) で、カメラだけを斜め上からの透視視点にし、青タワー側へ45°回して青の背中側から写す。地形は見た目のみで当たり判定なし |

## 開発用

開発サーバー (`npm run dev`) では `window.__flashCheck` に RoundSystem、`window.__flashCheckView.worldToClient(x, y)` にゲーム座標→画面座標の変換を公開しており、E2E自動操作に使える。
