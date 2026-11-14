import { describe, expect, it } from "vitest";
import { largestFitting, MAX_PREDICTIONS, predictCount, type FitProbe } from "./lineFit";

/** 決まった種から作る乱数 (テストを毎回同じにする)。 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** 前の探し方: 見積もりから 1 つずつ戻し、まだ入るなら 1 つずつ足す。 */
function linearFitting(lo: number, hi: number, guess: number, fits: (count: number) => boolean) {
  let count = Math.min(hi, Math.max(lo, guess));
  while (count > lo && !fits(count)) count--;
  if (fits(count)) while (count < hi && fits(count + 1)) count++;
  return count;
}

/** 探す範囲の個数に対する、確かめる回数の上限 (`lineFit.ts` の説明の 2 log2(個数) + 7)。 */
const probeLimit = (range: number) => 2 * Math.ceil(Math.log2(range + 1)) + MAX_PREDICTIONS + 3;

/** 先頭から `boundary` 個までが収まる行 (1 つの幅は 1)。確かめた回数を数える。 */
function line(boundary: number) {
  const probed: number[] = [];
  const probe = (count: number): FitProbe => {
    probed.push(count);
    return { fits: count <= boundary, width: count };
  };
  return { probe, probed };
}

describe("largestFitting", () => {
  it("見積もりが当たれば、見積もりと隣の 2 回で決まる", () => {
    const { probe, probed } = line(40);
    expect(largestFitting(1, 100, 40, probe, (count) => count)).toBe(40);
    expect(probed).toEqual([40, 41]);
    const over = line(39);
    expect(largestFitting(1, 100, 40, over.probe, (count) => count)).toBe(39);
    expect(over.probed).toEqual([40, 39]);
  });

  it("見積もりが上限でそのまま収まれば 1 回、下限で収まらなければ 1 回で決まる", () => {
    const all = line(100);
    expect(largestFitting(1, 100, 100, all.probe, () => 0)).toBe(100);
    expect(all.probed).toEqual([100]);
    // 1 つも収まらなければ下限を返す (呼び出し側が、下限でも収まらない行として扱う)
    const none = line(0);
    expect(largestFitting(1, 100, 1, none.probe, () => 50)).toBe(1);
    expect(none.probed).toEqual([1]);
    const fromAbove = line(0);
    expect(largestFitting(1, 100, 60, fromAbove.probe, () => 1)).toBe(1);
  });

  it("予測が当たれば、見積もりが大きく外れても数回で決まる (カーニングで狭い長い行)", () => {
    const { probe, probed } = line(85_690);
    // 1 つの幅は 1 なので、幅 = 個数。境目を測った幅から予測できる
    const predict = (count: number, width: number) => (count * 85_690) / width;
    expect(largestFitting(1, 100_000, 79_428, probe, predict)).toBe(85_690);
    expect(probed.length).toBeLessThanOrEqual(3);
  });

  it("どの見積もりと予測でも、収まる最大の個数を、回数の上限の内で返す (前の探し方と同じ結果)", () => {
    const next = random(1);
    const predictors: ((count: number, width: number) => number)[] = [
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => -5,
      () => 1e9,
      (count) => count,
      (count) => count + 1,
      (count) => count - 3,
      () => Math.floor(next() * 2000),
    ];
    for (let trial = 0; trial < 3000; trial++) {
      const lo = 1 + Math.floor(next() * 3);
      const hi = lo + Math.floor(next() * (trial % 10 === 0 ? 100_000 : 2000));
      const boundary = lo - 1 + Math.floor(next() * (hi - lo + 2));
      const guess = lo + Math.floor(next() * (hi - lo + 1));
      const predict = predictors[trial % predictors.length] as (
        count: number,
        width: number,
      ) => number;
      const { probe, probed } = line(boundary);
      const result = largestFitting(lo, hi, guess, probe, predict);
      expect(result).toBe(Math.max(lo, boundary));
      expect(result).toBe(linearFitting(lo, hi, guess, (count) => count <= boundary));
      expect(probed.length).toBeLessThanOrEqual(probeLimit(hi - lo + 1));
    }
  });
});

describe("predictCount", () => {
  // 1 つずつの幅は 2。行全体は 1 つにつき 1 % 狭い
  const sums = (count: number) => count * 2;

  it("1 つずつの幅の和を、測った幅との比で直して、収まる最大の個数を予測する", () => {
    // 1,000 個の行は 1,980。幅 2,000 には 1,010 個まで入ると予測する (1,010 × 2 × 0.99 = 1,999.8)
    expect(predictCount(1000, 1980, 2000, 1, 5000, sums)).toBe(1010);
    // 測った幅が見積もりより広ければ、少なく予測する
    expect(predictCount(1000, 2200, 2000, 1, 5000, sums)).toBe(909);
    // 範囲の外は予測しない
    expect(predictCount(1000, 1980, 2000, 1, 1005, sums)).toBe(1005);
    expect(predictCount(10, 1e9, 2000, 3, 5000, sums)).toBe(3);
  });

  it("幅か和が 0 以下なら、確かめた個数のまま", () => {
    expect(predictCount(10, 0, 2000, 1, 5000, sums)).toBe(10);
    expect(predictCount(10, 20, 2000, 1, 5000, () => 0)).toBe(10);
    expect(predictCount(10, Number.NaN, 2000, 1, 5000, sums)).toBe(10);
  });

  it("和を求めるのは、予測した位置までの距離に比例する範囲と、その対数の回数だけ", () => {
    const asked: number[] = [];
    const counting = (count: number) => {
      asked.push(count);
      return count * 2;
    };
    expect(predictCount(1000, 1980, 2000, 1, 100_000, counting)).toBe(1010);
    expect(Math.max(...asked)).toBeLessThanOrEqual(1000 + 2 * 10 + 1);
    expect(asked.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(10 + 1)) + 3);
  });
});
