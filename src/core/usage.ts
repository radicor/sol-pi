export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface CostRates {
  inputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_RATES: CostRates = {
  inputPerMTok: 2.0,
  cacheReadPerMTok: 0.4,
  cacheWritePerMTok: 8.0,
  outputPerMTok: 10.0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

export function zeroUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function usageCost(u: Usage, rates: CostRates): number {
  const M = 1_000_000;
  return (
    (u.input / M) * rates.inputPerMTok +
    (u.cacheRead / M) * rates.cacheReadPerMTok +
    (u.cacheWrite / M) * rates.cacheWritePerMTok +
    (u.output / M) * rates.outputPerMTok
  );
}

export function totalTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

export class UsageMeter {
  private total: Usage = zeroUsage();
  private perRequest: Usage[] = [];

  record(u: Usage): void {
    this.total = addUsage(this.total, u);
    this.perRequest.push(u);
  }

  get(): Usage {
    return this.total;
  }

  get requests(): number {
    return this.perRequest.length;
  }

  get perRequestUsage(): readonly Usage[] {
    return this.perRequest;
  }

  cost(rates: CostRates = DEFAULT_RATES): number {
    return usageCost(this.total, rates);
  }

  tokens(rates: CostRates = DEFAULT_RATES): number {
    return totalTokens(this.total);
  }
}
