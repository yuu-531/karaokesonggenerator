# 🎤 Karaoke Song Generator

ブラウザだけで完結するカラオケ Web アプリです。**ビルド不要・サーバー不要・外部 API 不要**（JSZip のみ同梱）の静的サイトとして動くため、GitHub Pages にそのまま置けます。

独自形式 **`.ksg`**（ZIP）で楽曲を読み書きし、**音声 / 映像 / 歌詞ワイプを `requestAnimationFrame` でミリ秒同期**して再生、マイクのピッチ解析による **Perfect / Good Miss 採点**、**波形 + ピアノロール + 歌詞タイミングのエディタ**を備えています。

---

## 特徴

| 分類 | 内容 |
| --- | --- |
| 再生 | 音声・背景映像・歌詞ワイプ・音程バーを rAF で同期。クリックシーク、±5秒ジャンプ |
| 歌詞 | 文字単位のタイミングによるカラーグラデーション・ワイプ（音節が無ければ行全体ワイプ） |
| キー / 話速 | 半音単位のキー変更（±）と 0.5〜1.5× の再生速度を**独立に**制御。「速度変更時もキーを保つ」ON でピッチシフタが補正 |
| エコー | 0〜100% のウェット量をリアルタイム変更 |
| 採点 | YIN 法でマイク音高を検出し、ノート単位で Perfect(100) / Good(60) / Miss(0) 判定。難易度 easy / normal / hard、スコア最大 10,000、コンボ、音程一致率、歌詞行別スコア、音程誤差グラフ |
| 録音 | 伴奏 + 自分の声（エコー込み）を MediaRecorder で録音 → 再生 / ダウンロード |
| エディタ | 波形スクラブ、ピアノロール（ドラッグで移動 / 右端・Shift+ドラッグで長さ伸縮 / `[` `]` でも伸縮 / 空きで新規 / Del 削除）、歌詞行と音節タイミング編集、自動分割・ノート整列 |
| 入出力 | `.ksg` の書き出し / 読み込み（ファイル選択・ドラッグ＆ドロップ）、**MIDI (`.mid`) のインポート**（ノート / BPM / 歌詞メタイベント）、ライブラリは IndexedDB に保存 |
| その他 | デモ曲の自動生成（WAV 合成）、ハイスコア記録、ダークテーマ・日本語 UI |

---

## 起動方法

### ローカル

ES Modules を使うため `file://` では動きません。いずれかの方法で配信してください。

```bash
# Python がある場合
python -m http.server 8080
# → http://127.0.0.1:8080/

# Node の場合
npx serve .
```

初回はライブラリが空なので **「デモ曲を生成」** を押すと、28 秒のデモ曲（42 ノート / 6 歌詞行）が自動生成されます。

### GitHub Pages で公開

1. このリポジトリを GitHub に push
2. **Settings → Pages → Build and deployment** で
   - Source: `Deploy from a branch`
   - Branch: `main` / `(root)`
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` が公開される

`docs/` フォルダに置く場合は Branch を `main` / `/docs` を選択してください。追加のビルド・依存インストールは不要です。

---

## ディレクトリ構成

```
karaokesonggenerator/
├── index.html              … 全ビュー（ライブラリ / プレイ / エディタ / 設定）の DOM
├── css/
│   └── style.css           … ダークテーマ、歌詞ワイプのグラデーション定義
└── js/
    ├── app.js              … ルーティング、ライブラリ、設定、.ksg インポート、キーボード
    ├── player.js           … プレイ画面の同期ループ (rAF)、判定、リザルト、録音 UI
    ├── editor.js           … エディタ制御（取込 / 保存 / 書出 / 歌詞パネル）
    ├── audio-engine.js     … Web Audio グラフ、キー・話速・エコー、マイク、録音
    ├── worklet/
    │   └── pitch-shifter.js… AudioWorklet（グラニュラ + WSOLA 相関探索のピッチシフタ）
    ├── ksg.js              … .ksg (ZIP) の読み込み / 書き出し
    ├── midi.js             … SMF パーサ & ライタ（音程データ）
    ├── lyrics-view.js      … 歌詞ワイプ描画
    ├── pitch-lane.js       … 音程バー（ターゲットと自分の音程の表示）
    ├── pitch.js            … YIN 法ピッチ検出、許容しきい値
    ├── scoring.js          … 採点エンジン
    ├── waveform.js         … 波形描画（ピークキャッシュ）
    ├── piano-roll.js       … ピアノロール描画とポインタ操作
    ├── store.js            … IndexedDB（曲）/ localStorage（設定・ハイスコア）
    ├── demo.js             … デモ曲の合成（OfflineAudioContext → WAV）
    ├── util.js             … DOM / 汎用ヘルパ
    └── vendor/
        └── jszip.min.js    … ZIP 処理（同梱・CDN 不使用）
```

外部依存は JSZip のみで、すべてリポジトリ内に同梱しています（オフラインでも動作）。

---

## `.ksg` ファイル仕様

`.ksg` は **ZIP アーカイブ**です（拡張子だけ独自。`.zip` として扱えます）。

```
your-song.ksg
├── info.json      … 必須。メタデータ
├── lyrics.json    … 必須。タイムスタンプ付き歌詞
├── melody.mid     … 任意。音程バー / 採点用の SMF
├── notes.json     … 任意。ノートの正確な値（SMF の曖昧さを回避する拡張）
├── audio.mp3      … 必須。伴奏・ボーカル（拡張子は wav / ogg / m4a 等でも可）
├── bg.mp4         … 任意。背景映像（webm / mov 等も可）
└── cover.png      … 任意。ジャケット
```

### `info.json`

```json
{
  "version": 1,
  "title": "ひかるあさ",
  "artist": "Karaoke Song Generator",
  "bpm": 120,
  "key": 0,
  "offset": 0,
  "duration": 28
}
```

### `lyrics.json`

```json
{
  "version": 1,
  "lines": [
    {
      "text": "きらきらひかる",
      "start": 2.0,
      "end": 6.0,
      "syllables": [
        { "text": "き", "start": 2.0, "end": 2.5 },
        { "text": "ら", "start": 2.5, "end": 3.0 }
      ]
    }
  ]
}
```

`syllables` が無い場合、行の `start`/`end` を文字数で等分してワイプします。行全体のタイミングも無ければ曲全体を自動等分します。

### `notes.json`（任意・拡張）

`melody.mid` と同じノートを秒単位の数値で保持します。SMF は同一ピッチのノートが重なるとノートオン/オフの対応が曖昧になるため、ノートを伸ばして重なりを作った状態でも正確に保存するために書き出しています。**このファイルが無くても再生可能**（`melody.mid` を解析）で、他ツールとの互換性も保てます。

```json
{
  "version": 1,
  "notes": [
    { "midi": 60, "start": 1.0, "dur": 0.5 }
  ]
}
```

### 読み込みのヒント

- 音声・映像は `audio.*` / `bg.*` のようなワイルド名も自動で探索します
- `lyrics.json` が不正でも再生は継続し、MIDI 解析失敗時も歌詞のみで動作します
- `notes.json` があればそれを優先し、無ければ `melody.mid` からノートを復元します

---

## 操作

### プレイ画面

| 操作 | 動作 |
| --- | --- |
| `Space` | 再生 / 一時停止 |
| `←` / `→` | ±5 秒シーク |
| `↑` / `↓` | キー +1 / −1 半音 |
| `R` | 録音開始 / 停止 |
| `Esc` | リザルト画面を閉じる |
| クリック | 進捗バーのシーク、ステージのクリックで開始 |

マイクを有効にすると採点が始まります（未接続時は MISS 判定をせず「採点は行われていません」と表示）。

### エディタ画面

| 操作 | 動作 |
| --- | --- |
| 空きをクリック | ノート新規作成 |
| ノートをドラッグ | 移動（時間 / 音高） |
| ノートの右端をドラッグ | 長さ変更 |
| `Shift` + ノートをドラッグ | ノート本体からでも長さ変更 |
| `]` / `[` | 選択ノートの長さを 1 グリッド伸ばす / 短くする |
| プロパティの「＋長さ / −長さ」 | 同上（ボタン操作） |
| `Del` / `Backspace` | 選択中のノート削除 |
| `Space` | プレビュー再生 |
| ルーラをドラッグ | スクラブ（波形も同期） |
| 波形ホイール | 時間スクロール |
| 歌詞行の ⏱ | 再生位置を行の開始時刻へ設定 |
| 🎚 MIDI を読み込む / `.mid` をドロップ | ノート・BPM・歌詞メタイベント（Lyric）を取り込む。歌詞行が無いときだけ行へ自動整形 |

グリッド（スナップ）は 1/1〜1/16 とオフを選択でき、ズームは 20〜400 px/秒。`[` `]` の伸縮幅は現在のグリッド幅（オフのときは 0.05 秒）です。

---

## 保存場所

| データ | 保存先 |
| --- | --- |
| 楽曲本体（音声・映像・MIDI・歌詞） | IndexedDB `ksg-db` / `songs` |
| 設定（難易度・グロー・マイク自動接続など） | localStorage `ksg_settings` |
| ハイスコア | localStorage `ksg_highscores` |

ブラウザの「サイトデータを削除」で消えます。消えても `.ksg` を書き出してあれば再インポートできます。

---

## 実装メモ

### 同期

`AudioContext.currentTime` から worklet の理論遅延 `delaySec` を差し引いた時刻を基準にし、`requestAnimationFrame` ごとに

1. 歌詞ワイプ（`--p` 変数へ文字単位の進捗を書き込み）
2. 音程バー / 採点（`Scorer#update(time, midi)`）
3. 映像 (`video.currentTime`) と UI（進行バー・タイマー）

を同一タイムラインで更新します。

### キー変更と話速の独立制御

- ノード: `AudioBufferSourceNode.playbackRate = S`（速度）
- ピッチシフタ: `ratio = 2^(T/12) / S`（キー補正）

(AudioWorklet が使えない環境では `detune` によるテープ式再生にフォールバックします。)

ピッチシフタは**グラニュラ合成 + WSOLA 相関探索**で、粒の境界での位相不連続を抑えています。出力遅延は
`delayFor(r) = max(0, ceil((r−1)·L)) + 512 + 8` サンプルとして計算し、映像・字幕側から同式で補正しています。

### 採点

| 難易度 | Perfect 帯 | Good 帯 |
| --- | --- | --- |
| easy | ±1.0 半音 | ±2.0 半音 |
| normal | ±0.55 半音 | ±1.5 半音 |
| hard | ±0.3 半音 | ±0.9 半音 |

発声フレームのうち Perfect 帯が 72% 以上で `Perfect`、Good 帯が 40% 以上で `Good`、それ以外（発声 3 フレーム未満も）で `Miss`。

---

## 対応ブラウザ

AudioWorklet・AudioContext・IndexedDB・`decodeAudioData` を利用するため、Chrome / Edge / Firefox / Safari の最新版を推奨します。マイク採点には HTTPS または `localhost` が必須です（GitHub Pages は HTTPS なので問題ありません）。
