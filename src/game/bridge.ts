import type { GameResult, RoundPhase, RoundResult } from "../domain/types";

export interface HudState {
  roundIndex: number;
  roundCount: number;
  phase: RoundPhase;
  /** このラウンドの相手チャンピオン名 */
  opponent: string;
  /** 本命の採点 + CSボーナス */
  totalScore: number;
  /** 進行中ラウンドのCS数とボーナス */
  roundCs: number;
  roundCsScore: number;
  flashReady: boolean;
  combo: number;
  lastResult: RoundResult | null;
}

type Events = {
  hud: HudState;
  complete: GameResult;
};

/** Phaser (ゲームループ) と React (HUD/画面遷移) の間の小さなイベントバス */
export class GameBridge {
  private readonly listeners = new Map<keyof Events, Set<(v: never) => void>>();

  on<K extends keyof Events>(event: K, cb: (v: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    this.listeners.get(event)?.forEach((cb) => (cb as (v: Events[K]) => void)(value));
  }
}
