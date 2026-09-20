// 記録画面のシロクマ。アイコンと同じ絵（icons/character.png）を使い回す。
// 手描きの SVG も試したが、アイコンの絵のほうが質が高いのでこちらに寄せた。
// 動きは CSS 側が持つ（絵そのものは差し替えない）。
//
// 読んだ分数で様子が変わる：
//   0分      … 寝ている（zzz が浮かぶ）
//   1〜29分  … 読んでいる（ゆっくり息をする）
//   30分以上 … ごきげん（軽く跳ねる）

export function stateFor(minutes) {
  if (!minutes) return 'sleep';
  if (minutes >= 30) return 'happy';
  return 'read';
}

export function line(state, minutes) {
  if (state === 'sleep') return 'きょうは まだ ひらいてない';
  if (state === 'happy') return 'きょうは ' + minutes + '分 よんだ';
  return 'よんでるところ（' + minutes + '分）';
}

export function html() {
  return '<div class="bearpic">' +
    '<img src="icons/character.png" alt="本を読むシロクマ" width="512" height="512" decoding="async">' +
    '<div class="zzz" aria-hidden="true"><span>z</span><span>z</span><span>z</span></div>' +
    '</div>';
}
