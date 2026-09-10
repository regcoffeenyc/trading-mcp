import type { StrategyName } from '../config.js';
import { MeanReversionStrategy } from './meanrev.js';
import { TrendStrategy } from './trend.js';
import type { Strategy } from './types.js';

export function createStrategy(name: StrategyName): Strategy {
  switch (name) {
    case 'trend': return new TrendStrategy();
    case 'meanrev': return new MeanReversionStrategy();
  }
}

export type { Signal, Strategy, StrategyContext } from './types.js';
export { strategyWindow } from './types.js';
