import { GAME_CONFIG } from "../src/config/balance";
import type { GeneratedEncounter, ScheduledEvent } from "../src/domain/types";

export function makeEncounter(events: ScheduledEvent[], over: Partial<GeneratedEncounter> = {}): GeneratedEncounter {
  return {
    definitionId: "TEST",
    champion: "default",
    name: "Test",
    kind: "STRAIGHT_FAST",
    seed: "t",
    roundIndex: 0,
    difficultyBudget: 1,
    roundDurationMs: 5_000,
    threatStartMs: 2_000,
    recognitionMs: 2_000,
    playerSpawn: { x: 300, y: 300 },
    enemySpawns: [{ x: 700, y: 300 }],
    minions: [],
    events,
    expectedAction: "FLASH",
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    idealMargin: GAME_CONFIG.scoring.defaultIdealMargin,
    ...over,
  };
}

export const fastLine = (atMs = 2_000): ScheduledEvent => ({
  atMs,
  type: "LINE_SHOT",
  isMainThreat: true,
  payload: {
    type: "LINE_SHOT",
    origin: { mode: "ENEMY" },
    aim: { mode: "ANCHOR", angleJitterRad: 0 },
    launchAtMs: atMs + 250,
    width: 80,
    speed: 1000,
    bodyLength: 50,
    maxTravel: 1300,
    enemyCast: true,
  },
});

export const circle = (atMs = 2_000, radius = 120, delay = 600): ScheduledEvent => ({
  atMs,
  type: "CIRCLE",
  isMainThreat: true,
  payload: { type: "CIRCLE", center: { mode: "ANCHOR", offset: { x: 0, y: 0 } }, radius, detonateAtMs: atMs + delay },
});
