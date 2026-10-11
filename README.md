# sb3-to-js

Scratch 3 と JavaScript を相互に変換する、依存パッケージ**ゼロ**（Node.js 18 以上のみ）のコンパイラ集です。

```
bounce.sb3  ──▶  sb3c     ──▶  bounce.js (+ bounce.html)     Scratch → 単体で動く JavaScript
game.js     ──▶  js2sb3   ──▶  game.sb3                      JavaScript（のサブセット）→ Scratch
```

- **`sb3c`** … `.sb3` を、ランタイム同梱の**単体 JavaScript** にコンパイルします。
- **`js2sb3`** … ブロックに静的に落とせる **JavaScript のサブセット**を読み、Scratch エディタで開ける `.sb3` を生成します（[js2sb3](#js2sb3-javascript--sb3) の章）。

> `sb3c` の出力 JS を `js2sb3` に戻すことはできません（出力は内部ランタイム用のコードで、元のブロック構造が失われているため）。
> `js2sb3` が読むのは、下記の仕様で書かれた「Scratch 向け JavaScript」です。

Scratch VM のようにブロックを 1 つずつ解釈するのではなく、各スクリプトを **ジェネレータ関数としてあらかじめ JavaScript に変換**します。
出力ファイルにはスケジューラ等の小さなランタイムも同梱されるので、`<script>` で読み込むだけ、または `node bounce.js` だけで動きます。

## クイックスタート

```bash
# 例題プロジェクトを作る（examples/bounce.sb3）
node examples/make-example.js

# コンパイル（.js と .html を出力）
node bin/sb3c.js examples/bounce.sb3 --html -o dist/bounce.js

# ブラウザで dist/bounce.html を開く。または Node でヘッドレス実行:
node dist/bounce.js --frames 90 --dump
```

グローバルにインストールすれば `sb3c` コマンドとして使えます。

```bash
npm install -g .
sb3c my-game.sb3 --html
```

## CLI

```
sb3c <input.sb3> [options]

  -o, --out <file>      出力 .js ファイル（既定: <input>.js）
      --html            <out>.html も出力（canvas と ▶/■ ボタン付き）
      --assets <mode>   inline（既定）: 画像・音を data: URI として埋め込み（1 ファイルで完結）
                        external: <out>_assets/ に書き出して URL で参照
      --title <text>    HTML のタイトル
      --check           コンパイルだけして警告を表示（ファイルは書かない）
  -q, --quiet           サマリを表示しない
```

未対応のブロックや拡張機能は、コンパイルを止めずに **警告として標準エラーに出力**されます（該当ブロックはスキップ）。

## 出力ファイルの使い方

### ブラウザ

`sb3c --html` が出力する HTML をそのまま開くのが最も簡単です。自分のページに組み込む場合:

```html
<canvas id="sb3-stage" width="480" height="360"></canvas>
<button id="sb3-flag">Start</button> <button id="sb3-stop">Stop</button>
<script src="bounce.js"></script>
```

`id="sb3-stage"` の canvas があれば自動で起動します（`data-autoplay="false"` で自動開始を無効化）。
手動で起動する場合は `Sb3Project.start('#my-canvas', { scale: 2, autoplay: true })` を使います。

### Node.js（ヘッドレス実行）

```bash
node bounce.js [--frames N] [--realtime] [--answers a,b,c] [--dump]
```

- 「◯と言う」の内容は標準出力に表示されます。
- 既定は**仮想時計**で、実時間を待たずに最大 30fps 相当で高速に進みます（`--realtime` で実時間）。
- 「聞いて待つ」には `--answers` で返答を渡せます。`--dump` は終了時の変数・リストを JSON で出力します。

### ライブラリとして

```js
const { compile } = require('sb3-to-js');
const fs = require('fs');

const { code, files, warnings, stats } = compile(fs.readFileSync('game.sb3'), {
  assets: 'inline',        // or 'external'（この場合 files に書き出すべきアセットが入る）
  title: 'My game',
});
fs.writeFileSync('game.js', code);

// コンパイル結果をその場で動かす（テストなどに便利）
const m = { exports: {} };
new Function('module', code)(m);
const rt = m.exports.createRuntime({ clock: 'virtual' });
rt.greenFlag();
rt.run({ maxFrames: 300 });
rt.pressKey('space');            // 入力のシミュレーションも可能
```

## 仕組み

1. **読み込み**: `.sb3` は zip なので、依存なしの小さな zip リーダ（stored / deflate）で `project.json` とアセットを取り出します。
2. **コンパイル**: 各ハットブロックから始まるスクリプトを JS の `function*` に変換します。
   - 式には静的な型（数値 / 文字列 / 真偽値 / 不明）を付け、**必要な場所にだけ型変換を挿入**します。定数は畳み込まれます。
   - 変数とリストは ID から解決され、見つからなければ名前で探し、それでもなければローカル変数として自動作成します（Scratch と同じ挙動）。
   - カスタムブロックは独立した関数になります。「画面を更新せずに実行」の有無で別バリアントを生成し、再帰呼び出しでは 1 フレーム譲ります。
3. **出力**: ランタイム（`src/runtime/*.js` を小さなバンドラで結合）＋プロジェクトデータ＋コンパイル済みスクリプトを 1 ファイルにまとめます。

```js
// 「ずっと { 10歩動かす; もし端に着いたら跳ね返る; steps を1ずつ増やす }」の出力例
while (true) {
  t.move(10);
  t.ifOnEdgeBounce();
  t.vars["v_steps"] = num(t.vars["v_steps"]) + 1;
  yield;
}
```

### スケジューラ

Scratch VM と同じ実行モデルを再現しています。

- `yield;` … ループ 1 周の終わり。見た目を変える命令（移動・表示など）が実行されたフレームではそこで 1 フレーム待ち、何も描画しないループは**同じフレーム内で何周も**回ります。
- `yield 1;` … 待機（`〜秒待つ`、`〜まで待つ`、`聞いて待つ` など）。
- `yield 2;` … 次のフレームまで休止（再帰呼び出し）。
- 「画面を更新せずに実行」のカスタムブロック内のループは yield せず、500ms を超えたときだけ譲ります。
- 1 フレームの処理時間は 1/30 秒の 75%（仮想時計ではパス数）で打ち切られます。
- ハットは Scratch VM と同じく、`旗` / `クリック` / `メッセージ受信` は同じスクリプトが実行中なら**再起動**し、`キー押下` / `背景切り替え` / `〜 > 値` は実行中なら何もしません。
- キーを押しっぱなしにすると、`キー押下` ハットは OS のキーリピートごとに起動します（Scratch と同じ）。
- 1 フレームに実行するスレッド数には上限があり、`クローンされたとき` の中で自分をクローンし続けるような暴走スクリプトでも、タブが固まらず警告を出して次のフレームへ進みます。

## 対応状況

| カテゴリ | 状況 |
| --- | --- |
| 動き | ほぼ全て（端での跳ね返り・画面外フェンス含む） |
| 見た目 | 吹き出し、コスチューム/背景、大きさ、表示/非表示、前後、効果（`幽霊`・`明るさ`・`色`は描画に反映、他は値のみ保持） |
| 音 | 再生 / 終わるまで再生 / 止める / 音量（効果は無視） |
| イベント | 旗、キー、スプライト/ステージのクリック、背景切り替え、メッセージ、`タイマー > 値` |
| 制御 | 繰り返し系、条件分岐、待つ、止める、クローン、`for each`、`while`、カウンタ |
| 調べる | タッチ判定（スプライト/マウス/端）、距離、キー、マウス、聞く/答え、タイマー、`〜の〜`、現在の日時 |
| 演算 | 全て（Scratch の比較・乱数・三角関数の挙動に合わせています） |
| 変数 / リスト | 全て（モニターは変数・リストの基本表示のみ） |
| カスタムブロック | 引数（文字列/数値・真偽）、再帰、画面を更新せずに実行 |
| ペン拡張 | 全消去、スタンプ、ペン上げ/下げ、色（色指定・色/鮮やかさ/明るさ/透明度）、太さ |

### 既知の制限（Scratch との違い）

- **タッチ判定・クリック判定はコスチュームの外形（回転した矩形）**で行います。ピクセル単位の判定ではないので、透明部分も当たりになります。
- `色に触れた` / `色が色に触れた` は常に `false`（警告を出力）。
- ペン以外の拡張機能（音楽、テキスト読み上げ、翻訳、ビデオ検出、各種ハードウェア）は未対応。ペンの旧式ブロック（`ペンの色を〜にする（数値）` など）も未対応です。
- カスタムブロックの再帰の深さは、通常で約 5,000 段、「画面を更新せずに実行」で約 3,900 段まで（超えるとそのスクリプトだけがエラーで終了します）。
- 「画面を更新せずに実行」の中の `待つ` は、Scratch のように実時間でビジーウェイトせず、通常どおり待機します。
- ラウドネス（マイク）は常に 0、ユーザー名は空文字、クラウド変数は通常の変数として扱います。
- SVG コスチュームの大きさはブラウザが読み込んだ実寸を使います（Node では `width`/`height`/`viewBox` から推定）。
- `.sb2` / `.sb`（Scratch 2 以前）は非対応です。

## js2sb3: JavaScript → .sb3

任意の JavaScript を Scratch に変換することは原理的にできません（Scratch には、オブジェクト・クロージャ・戻り値・`break` などがないため）。
そこで `js2sb3` は、**ブロックに静的に落とせる JavaScript のサブセット**を定義し、そのソースを**実行せずに読んで**ブロックへ変換します。
書けない構文は、**行・列つきのエラー**で理由と代替案を示します。

```bash
node bin/js2sb3.js examples/catcher.js           # → examples/catcher.sb3（Scratch エディタで開けます）
node bin/sb3c.js examples/catcher.sb3 --html     # → さらに単体の Web ページへ（往復）
```

```
js2sb3 <input.js> [options]
  -o, --out <file>   出力ファイル（既定: <input>.sb3）
      --json         project.json も書き出す（確認用）
      --check        チェックだけ（ファイルは書かない）
  -q, --quiet        警告やサマリを出さない
```

コスチュームや音のファイルは、**入力ファイルからの相対パス**で探します。終了コード: `0` 成功 / `1` ソースの誤り / `2` 使い方・入出力エラー。

### 例

```js
project({ title: 'Demo' });

let score = 0;                    // トップレベルの let → 全スプライト共通の変数（ステージ変数）
let items = [];                   // 配列 → リスト

sprite('Cat', { x: -100, y: 0 }, () => {
  let steps = 0;                  // スプライトの let → 「このスプライトのみ」の変数

  function bounce(times, big = false) {   // function → カスタムブロック（真偽値の既定値 → 真偽値の引数）
    repeat(times, () => { steps += 2; move(10); });
    if (big) { score += 100; }
  }

  onFlag(() => {                  // onFlag → 「旗が押されたとき」
    score = 0;
    items.push(1, 2, 'three');
    for (let i = 0; i < 5; i++) { score += i; }
    bounce(3, true);
    say('score: ' + score);
  });
});
```

### プログラムの構造

| 書き方 | 変換されるもの |
| --- | --- |
| `project({ title })` | プロジェクト情報（結果の `options` に入る） |
| `sprite('名前', { オプション }, () => { ... })` | スプライト（オプションは省略可） |
| `stage({ オプション }, () => { ... })` | ステージ（省略可） |
| トップレベルの `let x = 0;` / `let a = [];` | 全体で共通の変数 / リスト（初期値は**定数のみ**） |
| スプライト内の `let x = 0;` | そのスプライトだけの変数 / リスト |
| スクリプト・関数内の `let x = 式;` | スプライトの変数（宣言した場所で `〜にする`） |
| `function f(a, b = false) { ... }` | カスタムブロック。`= true/false` を持つ引数は**真偽値**引数 |
| 関数の先頭の `'use warp';` | 「画面を更新せずに実行する」 |
| トップレベルの `function` | 使っているすべてのスプライトにコピーされる |
| スプライト内の `function` | そのスプライトだけのカスタムブロック |
| `onFlag(fn)` `onKey('space', fn)` `onClick(fn)` `onBackdrop('名前', fn)` `onMessage('名前', fn)` `onCloneStart(fn)` `onTimer(秒, fn)` `onLoudness(値, fn)` | ハットブロック |

スプライト / ステージの本体に書けるのは、宣言とイベントハンドラだけです。

### 制御構文と演算子

| JavaScript | ブロック |
| --- | --- |
| `if / else if / else` | `もし〜なら / でなければ` |
| `while (cond) { }` | `〜まで繰り返す（not cond）`。`while (true)` は `ずっと` |
| `for (let i = 0; i < n; i++) { }` | `i を 0 にする` → `繰り返す（i < n でない）まで { 本体; i を 1 ずつ変える }`（条件は毎回評価） |
| `repeat(n, () => { })` `forever(() => { })` `repeatUntil(cond, () => { })` `waitUntil(cond)` `wait(秒)` | 同名のブロック |
| `return;` / `stopThisScript()` | `このスクリプトを止める`（カスタムブロック内では呼び出し元に戻る） |
| `x = 式` `x += n` `x -= n` `x++` | `〜にする` / `〜ずつ変える` |
| `x += 'abc'`、`x *= 2` など | `x を (x + 'abc') にする` のように式へ展開 |
| `+ - * / %` | `+ − × ÷ 〜を〜で割った余り` |
| `< > <= >= == === != !==` | `<` `>` `=`（`<=` は `not (>)`、`!=` は `not (=)`） |
| `&& \|\| !` | `かつ / または / 〜ではない` |
| `` `a${x}b` `` | `join` を重ねたもの |
| `s[i]` `s.length` `s.includes(t)` `s.charAt(i)` | `〜の〜番目の文字` / `〜の長さ` / `〜を含む` |
| `Math.floor/ceil/abs/sqrt/round/log/log10/exp`、`Math.sin/cos/tan/asin/acos/atan` | 数学ブロック（`Math.*` の三角関数は**ラジアン**で、角度に変換して呼びます） |
| `Math.pow(10, x)` `Math.pow(Math.E, x)` `Math.pow(x, 2)` | `10 ^` / `e ^` / `x × x` |
| `Math.random()` | `0 から 1.0 までの乱数`（小数。`1.0` と書くことで整数の乱数にならないようにしています） |
| `Math.PI` など | 定数 |

### リスト（配列）

配列は **JavaScript と同じ 0 始まり**で書きます（Scratch のリストは 1 始まりなので、`a[i]` は自動で `(i+1) 番目` に変換されます。`a[i - 1]` は `i 番目`、`a[0]` は `1 番目`）。

| JavaScript | ブロック |
| --- | --- |
| `a[i]`  `a[i] = v`  `a[i] += v` | `〜の i+1 番目` / `〜番目を〜で置き換える` |
| `a.length`  `a.length = 0` | `〜の項目数` / `〜のすべてを削除` |
| `a.push(x, y)`  `a.pop()`  `a.shift()`  `a.unshift(x)` | `〜に追加` / 最後を削除 / 1 番目を削除 / 1 番目に挿入 |
| `a.splice(i, n, ...items)` | 削除と挿入（`n` は**数値リテラル**） |
| `a.indexOf(x)`  `a.includes(x)` | `〜の位置 − 1`（無いとき `-1`）/ `〜を含む` |
| `a = [1, 2, 3]` | すべて削除してから追加 |

### 組み込み関数

ターゲット（スプライトの指定）には、スプライト名の文字列か、定数 `MOUSE` `RANDOM` `EDGE` `MYSELF` `STAGE` を渡します。

| カテゴリ | 関数 |
| --- | --- |
| 動き | `move(歩数)` `turnRight(度)` `turnLeft(度)` `goTo(x, y)` / `goTo(ターゲット)` `glide(秒, x, y)` / `glide(秒, ターゲット)` `pointInDirection(度)` `pointTowards(ターゲット)` `changeX` `setX` `changeY` `setY` `bounceOnEdge()` `setRotationStyle('left-right' \| "don't rotate" \| 'all around')` ／ `xPosition()` `yPosition()` `direction()` |
| 見た目 | `say(文[, 秒])` `think(文[, 秒])` `switchCostume(名前 \| 番号)` `nextCostume()` `switchBackdrop(...)` `switchBackdropAndWait(...)` `nextBackdrop()` `changeSize` `setSize` `changeEffect(効果, 値)` `setEffect(効果, 値)`（効果: `color` `fisheye` `whirl` `pixelate` `mosaic` `brightness` `ghost`）`clearEffects()` `show()` `hide()` `goToFront()` `goToBack()` `goForward(n)` `goBackward(n)` ／ `costumeNumber()` `costumeName()` `backdropNumber()` `backdropName()` `size()` |
| 音 | `playSound(名前)` `playSoundUntilDone(名前)` `stopAllSounds()` `changeVolume` `setVolume` ／ `volume()` |
| イベント | `broadcast(名前)` `broadcastAndWait(名前)` |
| 制御 | `stopAll()` `stopThisScript()` `stopOtherScripts()` `createClone([ターゲット])` `deleteClone()` |
| 調べる | `touching(ターゲット)` `distanceTo(ターゲット)` `keyPressed(キー)` `mouseDown()` `mouseX()` `mouseY()` `ask(質問)` `answer()` `timer()` `resetTimer()` `attributeOf('x position', 'スプライト名')` `current('year' \| 'month' \| 'date' \| 'dayofweek' \| 'hour' \| 'minute' \| 'second')` `daysSince2000()` `setDragMode('draggable' \| 'not draggable')` `loudness()` `username()` |
| 演算 | `random(a, b)` `join(a, b)` `mod(a, b)` `round(x)` `contains(文, 部分)` `letterOf(n, 文)`（`n` は 1 始まり）、**度数法**の `sin` `cos` `tan` `asin` `acos` `atan` |
| ペン | `clearPen()` `penDown()` `penUp()` `stamp()` `setPenColor('#rrggbb')` `setPenSize` `changePenSize` `setPenParam('color' \| 'saturation' \| 'brightness' \| 'transparency', 値)` `changePenParam(...)` |
| 変数 | `showVariable(変数名)` `hideVariable(変数名)`（変数・リストの名前を渡す） |

キー名は `'space'`、`'a'`〜`'z'`、`'0'`〜`'9'`、`'left arrow'` / `'up arrow'` / `'right arrow'` / `'down arrow'`、`'any'`（`'ArrowLeft'` や `'left'` も受け付けます）。

### スプライト / ステージのオプション

```js
sprite('Hero', {
  x: 0, y: 0, size: 100, direction: 90, visible: true, draggable: false, rotationStyle: 'all around', volume: 100,
  costumes: ['hero.svg', { name: 'walk', file: 'img/walk.png', rotationCenterX: 10, rotationCenterY: 20 },
             { name: 'dot', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }],
  sounds: ['pop.wav', { name: 'boom', file: 'sfx/boom.mp3' }],
  currentCostume: 'hero',          // 名前か番号（省略時は先頭）
}, () => { /* ... */ });
```

- コスチュームを省略すると、スプライトには既定のコスチューム、ステージには白い背景が付きます。
- アセットは `<md5>.<拡張子>` で `.sb3` に格納されます。回転中心を省略すると画像の中心です（PNG などは `bitmapResolution: 1`）。
- 画像は `svg` / `png` / `jpg` / `gif` / `bmp`、音は `wav` / `mp3` / `ogg`。WAV はヘッダからサンプリングレートとサンプル数を読み取ります。

### Scratch と JavaScript で意味が違うところ

`js2sb3` は **Scratch のブロックとして動く**ソースを書くための言語です。見た目は JavaScript ですが、動作は Scratch の規則に従います。

- **`+` は、どちらかが文字列なら連結、そうでなければ足し算**です。「文字列」とは、文字列リテラル・テンプレート・`join()`・**文字列で初期化した変数**（`let s = ''`）などです。型が分からない値どうし（引数など）は足し算になるので、連結したいときは `join(a, b)` か `` `${a}${b}` `` を使ってください。
- **`%` は Scratch の「余り」**（負の数では JavaScript と結果が違います: `-7 % 3` は `2`）。
- **`==` / `===` / `<` などは Scratch の比較**です（大文字小文字を区別せず、数字の文字列は数値として比べます）。`&&` `||` は真偽値だけを扱い、JavaScript のように値を返しません。
- 変数には数値か文字列が入ります。`true` / `false` は文字列 `"true"` / `"false"` として保存されます（条件として使えますが、数値としては 0 です）。`let x;` の初期値は `0` です。
- **`let` の局所変数はスプライトの変数**です（Scratch にはスタック上の変数がありません）。別のスコープの同名の変数は別の変数になり、ぶつかる場合は `i_2` のように名前が変わります。**再帰する関数の局所変数は、呼び出しの間で共有される**ので警告が出ます（引数は呼び出しごとに独立です）。
- カスタムブロックは**値を返せません**。結果は変数に入れてください。引数への代入もできません。
- 条件には、変数など真偽値以外の式もそのまま置けます（Scratch が真偽値に変換します）。リテラルの `true` / `false` は `1 = 1` / `1 = 0` に変換されます。
- `return;` の後ろ、`forever` / `stopAll()` / `deleteClone()` の後ろに書いたコードは到達できないので、**警告を出して捨てます**。
- 呼び出されないトップレベル関数も検証されます（警告: `never called`）。

### 使えないもの

エラーとして報告されます: `break` `continue` `do...while` `switch` `try` `class` `new` `this` `import` / `export`、`for...of` / `for...in`、分割代入、スプレッド、`?.` `??` `**`、三項演算子 `?:`、`async` / ジェネレータ、オブジェクト、`return 値`、式の中の代入や `++`、`Math.max/min` など Scratch に対応するブロックがないもの。

### ライブラリとして

```js
const { compileJs, formatError, CompileError } = require('sb3-to-js/src/js2sb3');   // または require('sb3-to-js').compileJs
const fs = require('fs');

try {
  const { sb3, json, assets, warnings } = compileJs(source, {
    filename: 'game.js',
    readFile: (p) => fs.readFileSync(p),    // costumes / sounds を読むとき
  });
  fs.writeFileSync('game.sb3', sb3);
} catch (e) {
  if (e instanceof CompileError) console.error(formatError(e, source));   // game.js:3:9: ... と該当行・^ を表示
  else throw e;
}
```

出力は決定的で（同じソースなら同じバイト列）、生成した `project.json` は内部で構造検証（`validateProject`）してから返します。

## プロジェクト構成

```
bin/sb3c.js            CLI（sb3 → JS）
bin/js2sb3.js          CLI（JS → sb3）
src/index.js           公開 API（compile, readSb3, compileJs）
src/compiler.js        project.json → JavaScript（ブロックごとの変換表）
src/emit.js            ランタイムのバンドル、出力ファイルと HTML の組み立て
src/zip.js             依存なしの zip リーダ
src/assets.js          MIME タイプ・画像サイズの検出
src/runtime/
  cast.js              Scratch の型変換・比較・リスト・色の関数（コンパイラと共有）
  target.js            スプライト / ステージ / クローンの状態と幾何
  runtime.js           スケジューラ、クローン、レイヤー、入力、各種ヘルパ
  renderer.js          Canvas 2D 描画（ブラウザ専用）
  audio.js             音の再生（ブラウザ専用）
  host.js              ブラウザ / Node 用の起動処理
src/js2sb3/
  lexer.js, parser.js  JavaScript サブセットの字句解析・構文解析（ESTree 風 AST）
  translate.js         AST → project.json（スコープ解決、式、文、カスタムブロック、ターゲット）
  stdlib.js            組み込み関数（move, say, onFlag ... ）とブロックの対応表
  validate.js          生成した project.json の構造検証
  sb3assets.js         コスチューム / 音の読み込み（md5 命名、既定のコスチューム）
  zipwriter.js         依存なしの zip ライタ（出力は決定的）
examples/              サンプル（make-example.js で bounce.sb3 を生成、catcher.js は js2sb3 用のゲーム）
test/                  node:test によるテスト
```

## テスト

```bash
npm test
```

`node:test` だけを使います。Scratch の比較・ループ・フレーム数、カスタムブロック（再帰/warp）、メッセージ、クローン、リスト、`.sb3` の読み込み（stored/deflate）、CLI のエンドツーエンドを検証します。
`js2sb3` は、JS → `.sb3` → `sb3c` のランタイムで**実際に実行して結果を確認**するテスト（演算・制御・関数・リスト・イベント・クローン）に加え、パーサ、`project.json` の構造、エラーメッセージの位置、CLI を検証します。
ブラウザ専用のコード（描画・入力・音）は、DOM のモックを使って**エラーなく通ること**までを確認しています。

> **注意**: テスト用プロジェクトは sb3 の仕様に沿って手で組み立てたものです。Scratch エディタで作った実際のプロジェクトでの検証や、実ブラウザでの見た目の確認はまだ十分ではありません。
> `js2sb3` の出力も、構造検証（`validate.js`）と `sb3c` のランタイムでの実行までは確認していますが、**公式の Scratch エディタで開いて確認したものではありません**。うまく動かないものがあれば、警告の出力と合わせて教えてください。
> そのほか、壊したソース 1.6 万件のファズ（内部クラッシュ 0）と、ランダム生成した正しいプログラム約 1,000 件のコンパイル・検証・実行も行っています。

## ライセンス

MIT
