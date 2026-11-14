/**
 * 行に入る個数 (折り返しの単位、または書記素クラスタ) を、計測の回数に上限を付けて探す (§4.7)。
 *
 * 行の幅は 1 つずつの幅の和で見積もってから行全体を測って確かめるが、カーニングがあると見積もりと行全体の幅が
 * ずれる。1 つずつ伸ばしては測り直すと、空白のない長い本文を広い枠に置いたとき、行のほぼ全体を何千回も
 * 測り直して固まる (入力のたびに同期で走る)。そこで次の順に探す:
 *
 * 1. 見積もった個数 (`guess`) を確かめる
 * 2. 境目がまだ決まらなければ、最後に測った幅と見積もりの比で境目を予測して確かめる。これを
 *    `MAX_PREDICTIONS` 回まで繰り返す (カーニングは行の中でほぼ一様に効くので、比で直した見積もりは境目の
 *    近くに来て、境目に近い位置で測るほど当たる)
 * 3. 最後に確かめた位置から、境目のある側へ間隔を倍にしながら広げ、二分探索で絞る
 *
 * 見積もりが当たれば (ふつうの文) 隣と合わせて 2 回で済み、外れても 2 log2(個数) + 7 回以内で済む。
 * 個数を増やすほど行は広がる (一度収まらなくなれば、それより多くても収まらない) とみなす。そのとき結果は、
 * 見積もりから 1 つずつ確かめる方法と同じ。
 */

/** 予測した位置を確かめる回数の上限。 */
export const MAX_PREDICTIONS = 4;

/** 先頭から決まった個数で作った行を測った結果。 */
export interface FitProbe {
  /** 行が収まるか */
  fits: boolean;
  /** 収まるかの判定に使った幅 (予測に使う) */
  width: number;
}

/**
 * `test` が真になる最大の数を、`good` (真と分かっている数。下限 − 1 ならまだない) と `bad` (偽と分かっている数。
 * 上限 + 1 ならまだない) の間で探す。最後に確かめた位置が `good` なら上へ、`bad` なら下へ、間隔を倍にしながら
 * 広げて境目を越えたら、二分探索で絞る。見つからなければ `good` のまま返す。
 */
function searchFrom(
  good: number,
  bad: number,
  upward: boolean,
  test: (count: number) => boolean,
): number {
  for (let step = 1; bad - good > 1; step *= 2) {
    const count = upward ? Math.min(bad - 1, good + step) : Math.max(good + 1, bad - step);
    const fits = test(count);
    if (fits) good = count;
    else bad = count;
    if (fits !== upward) break;
  }
  while (bad - good > 1) {
    const count = good + Math.floor((bad - good) / 2);
    if (test(count)) good = count;
    else bad = count;
  }
  return good;
}

/**
 * 収まる最大の個数を `lo..hi` で探す。収まる個数がなければ `lo` を返す (呼び出し側が、`lo` 個でも収まらない行
 * として扱う)。`probe` は同じ個数で何度も呼ぶことがあるので、呼び出し側で結果を覚えること。
 * `predict` は、ある個数の行を測った幅から、境目の個数を予測する (`predictCount`)。
 */
export function largestFitting(
  lo: number,
  hi: number,
  guess: number,
  probe: (count: number) => FitProbe,
  predict: (count: number, width: number) => number,
): number {
  let good = lo - 1;
  let bad = hi + 1;
  let at = Math.min(hi, Math.max(lo, guess));
  for (let round = 0; ; round++) {
    const result = probe(at);
    if (result.fits) good = at;
    else bad = at;
    if (bad - good <= 1 || round === MAX_PREDICTIONS) break;
    // 分かっている範囲の内側へ寄せる (外れた予測でも、範囲は 1 つ以上狭まる)
    const predicted = predict(at, result.width);
    const target = Number.isFinite(predicted) ? Math.round(predicted) : at;
    at = Math.min(bad - 1, Math.max(good + 1, target));
  }
  return Math.max(
    lo,
    searchFrom(good, bad, good === at, (count) => probe(count).fits),
  );
}

/**
 * 1 つずつの幅の和 (`sumAt(count)` = 先頭から count 個の和) を、`count` 個の行を測った幅 `width` との比で
 * 直したときに、`limit` 未満に収まる最大の個数 (`lo..hi`。なければ `lo`)。和は個数とともに増えるとみなす。
 * `sumAt` を呼ぶのは、`count` から予測した位置までの距離の 2 倍の範囲と、その対数の回数だけ。
 */
export function predictCount(
  count: number,
  width: number,
  limit: number,
  lo: number,
  hi: number,
  sumAt: (count: number) => number,
): number {
  const estimated = sumAt(count);
  if (!(estimated > 0) || !(width > 0)) return count;
  const target = (limit * estimated) / width;
  const below = (n: number) => sumAt(n) < target;
  const upward = below(count);
  return Math.max(lo, searchFrom(upward ? count : lo - 1, upward ? hi + 1 : count, upward, below));
}
