# ハンドオフ

更新ルール: `.claude/rules/handoff.md`（タスクの完了時に更新する）

## 現在地

- 最終更新: 2026-10-14、T-014 の完了時
- ブランチ: 作業は `feature/paint-bookmarklet` で行い、終わったら `main` へ fast-forward で取り込んでプッシュしている。`main` へのプッシュで CI（テスト）と Pages のデプロイが走る。PR を使う運用はまだ決めていない
- CI: GitHub Actions「Pages」は test 成功。deploy は Pages が未設定で失敗中（T-002）
- 公開: インストールページは Artifact（非公開）で公開済み。GitHub Pages は Source の設定待ち
- 人の操作待ち: `.human/requests.md` の R-001（Pages の Source 設定）、R-002（ライセンス）、R-003（改善の着手順）
- 次の一手: R-003 の回答に従って改善を始める。指定がなければ T-003（スクロール追従。`.human/ideas/scroll-follow.md` に方式の比較あり）

## 始め方

```sh
npm install          # terser 5.36.0 と playwright 1.56.1（ブラウザは /opt/pw-browsers にある）
npm test             # ビルドしてから Playwright のテスト 16 件
npm run bench        # 性能計測（メインスレッドの占有時間）
```

- ソースを変えたら `npm run build` を流し、`dist/` と `docs/` もコミットする。CI は生成物がソースと一致するかを `git diff --exit-code -- dist docs` で確かめる。
- Artifact の更新は、`node build.mjs --page <scratchpad>/paint-bookmarklet.html` で本文だけの版を作って公開する。別のセッションから更新するときは、先に URL を read してから url を指定して publish する。

## 地図

- `src/paint.js`: 本体。`// ---------- 名前 ----------` の節で区切ってある。
  - 状態、ツールバー、UI 同期（setTool / syncTool / setColor …）、キャンバスのサイズ管理（fit, warm）
  - 履歴（push / swap / pack / gather / grow、undo / redo / clearAll）
  - ストローク状態と入力: onDown → onMove（inkMove, readPred, drawTail / eraseMove / drawShape）→ onUp → endStroke（commitLive）。abortStroke はパームリジェクションで使う
  - タイル（markBox / markSeg / markCurve / markShape / tileRects / resetTiles）
  - 塗りつぶし（floodFill）、書き出し（save / copyImg）、HUD（D キー）、キーボード（onKey）、表示制御（show / hide / toggle / destroy）、起動
- `src/install.html`: インストールページのテンプレート（本文のみ）。`%%BOOKMARKLET_HREF%%` などを build.mjs が置き換える
- `build.mjs`: terser で圧縮し、`dist/paint.min.js`、`dist/bookmarklet.txt`、`docs/index.html` を作る
- `test/paint.test.mjs`（テスト 16 件）、`test/helpers.mjs`（サーバー・起動・画素の読み取り）、`test/bench.mjs`
- `.github/workflows/pages.yml`: main へのプッシュでテストしてから docs/ を Pages に公開。PR ではテストだけ
- `.claude/`: CLAUDE.md（概要と読み込み）、`rules/`（tasks / handoff / human）、TASKS.md、HANDOFF.md、Stop フック（`hooks/check-handoff.mjs`）
- `.human/`: ユーザーとの非同期のやりとり。`ideas/`（ユーザーのアイデア、1 件 1 ファイル）、`requests.md`（Claude からの判断・作業のお願い）
- 公開 API: `window.__paintBookmarklet` の `toggle / show / hide / destroy / undo / redo / clear / tool(name) / color(hex) / stats()`。テストとベンチがこれを使う

## 不変条件（壊すと困る）

- main キャンバスを変える操作は必ず `push(R, atlas)` で履歴に積む。描いた範囲 `cb*` は push / swap で広げ、clearAll で空にする。塗りつぶしの読み戻し範囲がこれに依存している。
- 消しゴムでは `markBox` / `markSeg` を `stroke()` より前に呼ぶ（削る前のタイルを退避するため）。
- 入力のホットパス（onMove 以下）では、オブジェクトの割り当ても DOM の読み書きもしない。`now()` を呼ぶのは HUD を表示しているときだけ。
- 座標はデバイスピクセル（client × dpr）で扱う。キャンバスの W / H は縮めない（fit は大きくなるときだけ作り直す）。
- 描画中（`act !== -1`）は fit・undo・clear をしない。fit は `pendingFit` で後回しにする。
- 半透明の線は live / pred に不透明で描き、2 枚をまとめたグループに CSS の opacity をかける。確定時に globalAlpha で一度だけ main に合成する。
- innerHTML・style 属性・外部リソースは使わない（CSP と Trusted Types への対策）。
- 2 回目の実行は表示の切り替えだけ（`window.__paintBookmarklet` で判定）。

## 決定事項と理由

- 絵は画面に固定し、スクロールには追従しない。実装の単純さと、どのページでも同じ挙動になることを優先した。使いやすさでは最大の弱点（T-003）。
- Delegated Ink Trail は Windows だけで使う。他の OS では API があっても OS が描かない可能性があり、その場合に予測線まで失うため。
- pointerrawupdate のリスナーは描画中だけ登録する（登録しているだけでコストがかかる）。図形は 1 フレームに 1 回で足りるので使わない。
- 履歴は 128px タイルと外接矩形のうち面積の小さい方で保存する。消しゴムはコピーオンライト。
- 起動直後に warm() で初回コストを前払いする（初回の確定が 17ms → 2ms、@2x で 60ms → 4ms）。
- ライセンスは未設定（R-002 でユーザーに確認中。おすすめは MIT）。

## 落とし穴

- 合成した PointerEvent の timeStamp は生成時刻になる。pointerdown より前に作った move は重複として捨てられる（ベンチで一度これにハマった）。
- headless での getImageData の読み戻しは数百 ms かかることがある。時間に依存するテスト（パームリジェクションの 500ms）は、イベントを全部撃ってから検証する。
- headless Chromium は SwiftShader（ソフトウェア GPU）で動く。GPU 寄りの処理時間は実機より悲観的に出る。初回だけ遅いのはバッキングの確保が原因（→ warm）。
- この作業環境から *.github.io へはつながらない（ネットワークポリシーで 403）。公開の確認は GitHub API（Actions のジョブ結果）で行う。
- Playwright の mouse で viewport の外（負の座標）からドラッグを始めると、pointerdown がツールに届かない。
- `page.evaluate(CODE)` は CSP を通さずに実行する（Firefox のブックマークレットに相当）。本物の `javascript:` URL として実行するには `location.href = BOOKMARKLET` を使う（CSP のないページでだけ動く）。
- Artifact のビューアはダウンロードをブロックするので、そこでは PNG 保存ボタンが反応しない。

## 検証の方法

- `npm test` で見ていること: 起動とトグル・破棄、速い線が途切れない、undo / redo が画素単位で一致、消しゴム（右クリック含む）、半透明の重なり、四角と塗りつぶし（隙間・漏れ）、筆圧、パームリジェクション、ページへのイベント漏れ、入力欄にフォーカスがあるときのショートカット、厳格な CSP と Trusted Types、リサイズ、図形と Shift、PNG 保存、塗りつぶしの壁と再着色、rawupdate と pointermove の重複処理。
- 未確認: Firefox と Safari での動作、実際のペンタブレット、Windows の Ink Trail、実 GPU での desynchronized の効果。

## 外部の状態

- GitHub: shutsuruwork-afk/paint-tool（public）。ブランチは main と feature/paint-bookmarklet
- Actions: Pages ワークフロー。run 38542922393 は test 成功、deploy は Pages が未設定で失敗
- Pages: 未有効。公開予定の URL は https://shutsuruwork-afk.github.io/paint-tool/
- Artifact: https://claude.ai/artifact/Aj3XQxn6Q7EUaiHjYAFbve（インストールページ、非公開）。`docs/index.html` の本文だけの版

## 完了ログ（新しい順）

### T-014 `.human/` を作り、アイデアとお願いのやりとりを始める — 2026-10-14
- 変更: `.human/`（README、`ideas/`、`requests.md`）と `.claude/rules/human.md` を追加。CLAUDE.md から requests.md を読み込むようにした。
- ideas に 2 件を登録: 文字ボックス（T-009 に紐づけ）、スクロール追従（T-003 に紐づけ。方式 A/B/C の比較を書き、B の「描いた所にだけページ座標のタイルを置く」を第一候補にした）。
- requests に 3 件を登録: R-001 Pages の Source 設定、R-002 ライセンス、R-003 改善の着手順。
- 確認: Stop フックが漏れなしと判定すること、CLAUDE.md の読み込み先のファイルがあること。
- 残課題: なし。

### T-001 タスクとハンドオフの運用ルールを作る — 2026-10-14
- 変更: `.claude/` に CLAUDE.md（概要と TASKS・HANDOFF の読み込み）、`rules/tasks.md`、`rules/handoff.md`、TASKS.md、HANDOFF.md、Stop フック（`hooks/check-handoff.mjs` と `settings.json`）を追加した。
- 確認: フックに模擬入力を渡して 4 つの場合を試した。完了ログに漏れがあればブロック、漏れがなければ素通し、`stop_hook_active` なら素通し、ファイルがなければ素通し。
- 残課題: なし。フックが実際の停止で発火するかは、次のセッションで確かめる（未確認）。

### ルール導入前
- 初版: 低遅延ペイント本体、インストールページ、テスト 16 件、ベンチ（b663793）
- GitHub Pages ワークフロー（f519054）
