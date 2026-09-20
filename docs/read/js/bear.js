// 記録画面のシロクマ。SVG を組み立てるだけで、動きは CSS 側が持つ。
// 画像は使わない（テーマの色に追随させたいので、塗りは token から取る）。
//
// 読んだ分数で様子が変わる：
//   0分      … 寝ている
//   1〜29分  … 読んでいる
//   30分以上 … ごきげん

export function stateFor(minutes) {
  if (!minutes) return 'sleep';
  if (minutes >= 30) return 'happy';
  return 'read';
}

export function line(state, minutes) {
  if (state === 'sleep') return 'きょうはまだ ひらいてない';
  if (state === 'happy') return 'きょうは ' + minutes + '分 よんだ';
  return 'よんでるところ（' + minutes + '分）';
}

// 512 の座標系で描いて、表示側で縮める
export function svg() {
  return `
<svg id="bear" viewBox="0 0 320 250" width="100%" height="100%" role="img" aria-label="本を読むシロクマ">
  <defs>
    <clipPath id="bearEyeL"><circle cx="126" cy="126" r="11"/></clipPath>
    <clipPath id="bearEyeR"><circle cx="186" cy="126" r="11"/></clipPath>
  </defs>

  <!-- 影 -->
  <ellipse class="b-shadow" cx="160" cy="226" rx="86" ry="11"/>

  <g class="b-body">
    <!-- 耳 -->
    <g class="b-ear b-ear-l"><circle cx="106" cy="62" r="24"/><circle class="b-inner" cx="106" cy="64" r="12"/></g>
    <g class="b-ear b-ear-r"><circle cx="214" cy="62" r="24"/><circle class="b-inner" cx="214" cy="64" r="12"/></g>

    <!-- からだ（頭と胴をひとつの丸で） -->
    <ellipse class="b-fur" cx="160" cy="132" rx="96" ry="92"/>
    <ellipse class="b-shade" cx="204" cy="150" rx="44" ry="66"/>

    <!-- ほお -->
    <ellipse class="b-blush" cx="102" cy="150" rx="16" ry="10"/>
    <ellipse class="b-blush" cx="218" cy="150" rx="16" ry="10"/>

    <!-- 目（まばたきはまぶたを下ろす） -->
    <g class="b-eyes">
      <circle class="b-eye" cx="126" cy="126" r="11"/>
      <circle class="b-eye" cx="186" cy="126" r="11"/>
      <circle class="b-glint" cx="130" cy="122" r="4"/>
      <circle class="b-glint" cx="190" cy="122" r="4"/>
      <rect class="b-lid" clip-path="url(#bearEyeL)" x="113" y="101" width="26" height="26"/>
      <rect class="b-lid" clip-path="url(#bearEyeR)" x="173" y="101" width="26" height="26"/>
    </g>
    <!-- 寝ているときの目 -->
    <g class="b-sleepeyes">
      <path d="M116,126 q10,9 20,0"/>
      <path d="M176,126 q10,9 20,0"/>
    </g>

    <!-- はな・くち -->
    <ellipse class="b-nose" cx="156" cy="152" rx="11" ry="8"/>
    <path class="b-mouth" d="M156,162 q8,10 17,3"/>

    <!-- めがね -->
    <g class="b-glasses">
      <circle cx="126" cy="126" r="26"/>
      <circle cx="186" cy="126" r="26"/>
      <path d="M152,122 q8,-4 8,0"/>
      <path d="M212,118 q14,-4 20,-14"/>
      <path d="M100,118 q-14,-4 -20,-14"/>
    </g>
  </g>

  <!-- 本 -->
  <g class="b-book">
    <path class="b-cover" d="M78,196 Q118,182 160,180 L160,222 Q118,226 82,234 Z"/>
    <path class="b-cover" d="M242,196 Q202,182 160,180 L160,222 Q202,226 238,234 Z"/>
    <path class="b-page" d="M90,196 Q124,185 160,184 L160,218 Q124,222 94,229 Z"/>
    <path class="b-page" d="M230,196 Q196,185 160,184 L160,218 Q196,222 226,229 Z"/>
    <g class="b-lines">
      <rect x="104" y="196" width="40" height="4" rx="2"/>
      <rect x="104" y="206" width="32" height="4" rx="2"/>
      <rect x="176" y="194" width="40" height="4" rx="2"/>
      <rect x="176" y="204" width="30" height="4" rx="2"/>
    </g>
  </g>

  <!-- 前足 -->
  <ellipse class="b-paw b-paw-l" cx="104" cy="200" rx="20" ry="15"/>
  <ellipse class="b-paw b-paw-r" cx="216" cy="200" rx="20" ry="15"/>

  <!-- 寝ているときだけ出る -->
  <g class="b-zzz">
    <text x="236" y="72" class="b-z1">z</text>
    <text x="252" y="52" class="b-z2">z</text>
    <text x="268" y="34" class="b-z3">z</text>
  </g>
</svg>`;
}
