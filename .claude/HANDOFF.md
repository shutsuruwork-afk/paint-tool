# ハンドオフ

更新ルール: `.claude/rules/handoff.md`（タスクの完了時に更新する）

## 現在地

- 最終更新: 2026-10-14、T-006 の完了時
- ブランチ: 作業は `feature/paint-bookmarklet` で行い、終わったら `main` へ fast-forward で取り込んでプッシュしている。`main` へのプッシュで CI（テスト）と Pages のデプロイが走る。PR を使う運用はまだ決めていない。HEAD は T-006 のコミット（`git log --grep T-006`）
- CI: GitHub Actions「Pages」は main へのプッシュごとに test → deploy。T-003 のプッシュ（run 38595502374）は成功。T-006 のプッシュの結果は Actions で確かめる
- 公開: https://shutsuruwork-afk.github.io/paint-tool/ （GitHub Pages）と Artifact（非公開）の 2 か所。版は v1.2.0
- 人の操作待ち: なし。着手順は R-003 で決まった（T-003 → T-006 → T-005 → T-004 → T-009）。使ってみて分かることはユーザーがフィードバックしてくれる
- 次の一手: T-005（色・太さ・ツール・ツールバー位置を次回の起動でも覚えておく）に着手する。保存先を先に調べる（ページの localStorage を汚さない方法）。ユーザーからフィードバックが来たら、そちらを先に見る

## 始め方

```sh
npm install          # terser 5.36.0 と playwright 1.56.1（ブラウザは /opt/pw-browsers にある）
npm test             # ビルドしてから Playwright のテスト 28 件
npm run bench        # 性能計測（メインスレッドの占有時間）
```

- ソースを変えたら `npm run build` を流し、`dist/` と `docs/` もコミットする。CI は生成物がソースと一致するかを `git diff --exit-code -- dist docs` で確かめる。
- Artifact の更新は、`node build.mjs --page <scratchpad>/paint-bookmarklet.html` で本文だけの版を作って公開する。別のセッションから更新するときは、先に URL を read してから url を指定して publish する。

## 地図

- `src/paint.js`: 本体。`// ---------- 名前 ----------` の節で区切ってある。
  - ホスト要素: 画面に固定する host（UI、live / pred、top layer）と、ページに貼り付ける surf（`paint-bookmarklet-surface`、確定した絵）の 2 つを documentElement 直下に置く。`pin()` で `!important` のインラインスタイルを当てる
  - 状態、面（mapNow / origin / dtile / forTiles / sizeSurface）、ツールバー、UI 同期（setTool / syncTool / liveAlpha / setColor …）、キャンバスのサイズ管理（fit, warm）
  - 履歴（push / swap / pack / gather / grow、undo / redo / clearAll）。gather は面のタイルからアトラスへ、swap はアトラスと面を入れ替える
  - ストローク状態と入力: onDown（finishHandoff → mapNow）→ onMove（inkMove, readPred, drawTail / eraseMove → erasePts / drawShape）→ onUp → endStroke（commitLive → 2 フレーム後に finishHandoff）。abortStroke はパームリジェクションで使う
  - タイル（markBox / markSeg / markCurve / markShape / tileRects / resetTiles）。印は面の座標で Set に付ける
  - お知らせ（`say(msg, ms, act, fn)`。fn を渡すとボタン付き）、塗りつぶし（floodFill）、書き出し（capture / exportBlob / save / copyImg / pixels）、HUD（D キー）、キーボード（onKey）、表示制御（show / hide / toggle / close → endBye / reopen / onByeKey、destroy）、起動
- `src/install.html`: インストールページのテンプレート（本文のみ）。`%%BOOKMARKLET_HREF%%` などを build.mjs が置き換える
- `build.mjs`: terser で圧縮し、`dist/paint.min.js`、`dist/bookmarklet.txt`、`docs/index.html` を作る
- `test/paint.test.mjs`（テスト 28 件）、`test/helpers.mjs`（サーバー〈`/long` は縦 3000px、`/offset` は html に余白〉・起動・画素の読み取り `readMain` / `screenPixel`・`scrollTo`）、`test/bench.mjs`
- `.github/workflows/pages.yml`: main へのプッシュでテストしてから docs/ を Pages に公開。PR ではテストだけ
- `.claude/`: CLAUDE.md（概要と読み込み）、`rules/`（tasks / handoff / human）、TASKS.md、HANDOFF.md、Stop フック（`hooks/check-handoff.mjs`）
- `.human/`: ユーザーとの非同期のやりとり。`ideas/`（ユーザーのアイデア、1 件 1 ファイル）、`requests.md`（Claude からの判断・作業のお願い）
- 公開 API: `window.__paintBookmarklet` の `version / toggle / show / hide / close / destroy / undo / redo / clear / tool(name) / color(hex) / stats() / pixels(x, y, w, h)`。テストとベンチがこれを使う。`pixels` は画面の CSS 座標の矩形を面から読み戻す（確定した絵だけ。live は含まない）。`stats()` に `surface`（面の大きさ）と `tiles`（表示タイルの数）がある

## 不変条件（壊すと困る）

- 座標は 2 種類。V は画面のデバイスピクセル（client × dpr。入力、live / pred）、S は面のピクセル。S = V × sk + (sox, soy)。sk・sox・soy は onDown の `mapNow()` で 1 回だけ求め、ストローク中は変えない。面の密度 `sdpr` は起動時の dpr で固定し、表示タイルの大きさ DT もそこで決まる。
- 面を変える操作は必ず `push(R, atlas)` で履歴に積む（R は S 座標）。描いた範囲 `cb*` は push / swap で広げ、clearAll で空にする。塗りつぶしの読み戻し範囲がこれに依存している。
- 消しゴムでは `markBox` / `markSeg` を `erasePts()` より前に呼ぶ（削る前のタイルを退避するため）。
- 入力のホットパス（onMove 以下）では、オブジェクトの割り当ても DOM の読み書きもしない。面のタイルの読み戻しもしない。`now()` を呼ぶのは HUD を表示しているときだけ。erasePts は `ePts`（Float64Array）と既存タイルのループだけで動く。
- live / pred の W / H は縮めない（fit は大きくなるときだけ作り直す）。面は `sizeSurface()` で文書の大きさに合わせる（縮むこともある。タイルは消さず、clip で隠れるだけ）。
- 描画中（`act !== -1`）は fit・undo・clear をしない。fit は `pendingFit` で後回しにする。
- 確定の受け渡し: commitLive はタイルに描いたのと同じフレームでグループの opacity を 0 にし、live は 2 フレーム後に `finishHandoff()` で消す。次の onDown・undo・redo・fit は先に finishHandoff を呼ぶ。受け渡し中は liveAlpha が opacity を戻さない。
- 半透明の線は live / pred に不透明で描き、2 枚をまとめたグループに CSS の opacity をかける。opacity はツールや濃さが変わった時点で `liveAlpha()` が先に合わせておく（描き始めの 1 フレームが濃くならないように）。確定時に globalAlpha で一度だけ面に合成する。
- scroll / wheel のリスナーは登録しない（テストで確かめている）。スクロールはブラウザに任せる。
- innerHTML・style 属性・外部リソースは使わない（CSP と Trusted Types への対策）。
- 2 回目の実行は表示の切り替えだけ（`window.__paintBookmarklet` で判定）。閉じた後の取り消し待ち（`byeT`）の間は、show / toggle が reopen になる。
- × は `close()`（描いた物があれば BYE_MS = 8 秒の取り消し待ち。その後に destroy）。API の `destroy()` はすぐに解放する（テストで確かめている）。取り消し待ちの間は visible = false で、入力のリスナーも外れている。

## 決定事項と理由

- 絵はページに貼り付ける（T-003、ideas/scroll-follow.md の方式 B）。確定した絵はページ座標の canvas タイル（面）に描き、スクロールはブラウザの合成に任せる。ページ全体の大きさのキャンバス 1 枚（方式 A）は長いページでメモリと上限に当たり、スクロールのたびに JS で動かす方式（C）は絵が 1 フレーム以上遅れるので捨てた。
- 描いている途中の線（live / pred）は画面に固定のまま。入力の経路と遅延を一切変えないため。代わりに描画中のスクロールには追従しない（開始時の位置に確定）。
- 表示タイルは約 256 CSS px（DT = 128 × max(2, round(sdpr × 2)) デバイス px）。512 px だと初めて触れたときの確保が @2x で重く、128 px だと要素数が増える。履歴タイル 128 の倍数なので、履歴タイルが表示タイルをまたがない。
- 表示タイルは desynchronized にしない。数が多いと低遅延の経路が重く、合成の順序も live とずれる。ちらつきは受け渡し（2 フレーム後に live を消す）で防ぐ。
- 面の密度は起動時の dpr で固定する。表示倍率を変えても絵を作り直さず、sk で座標を換算する（ブラウザが拡大縮小して表示する）。
- 面は documentElement 直下の absolute 配置で、html のずれ（margin・border・position）は getBoundingClientRect から求めた hdx / hdy で打ち消す。contain: strict と overflow: clip で、はみ出してスクロール範囲を広げない。
- 範囲外にしたもの: ページ内の一部だけがスクロールする要素（Gmail など。T-017 の候補）、描いた後に本文が動くことによるずれ、「画面に固定」モード（動画や地図の上に描く用。T-016 の候補）。
- 閉じる（×）は確認ダイアログではなく、8 秒の取り消し（お知らせのボタン・Ctrl/⌘+Z・ブックマークレット）にした（T-006）。確認は毎回 1 手増えるが、取り消しなら閉じる人の手間は変わらない。残り時間は CSS のアニメーションのバーで見せる（JS は動かない）。何も描いていなければすぐ閉じる。
- 塗りつぶしは見えている画面の範囲だけで行う。文書全体を読み戻すと長いページで重いため。
- Delegated Ink Trail は Windows だけで使う。他の OS では API があっても OS が描かない可能性があり、その場合に予測線まで失うため。
- pointerrawupdate のリスナーは描画中だけ登録する（登録しているだけでコストがかかる）。図形は 1 フレームに 1 回で足りるので使わない。
- 履歴は 128px タイルと外接矩形のうち面積の小さい方で保存する。消しゴムはコピーオンライト。
- 起動直後に warm() で初回コストを前払いする（T-003 以前の計測で初回の確定が 17ms → 2ms、@2x で 60ms → 4ms）。面のタイルは描いた所に作るので前払いできず、初めて描く場所の確定は数 ms 重い。
- ライセンスは MIT（R-002 でユーザーが決定）。著作権者の表記は GitHub のユーザー名 shutsuruwork-afk。

## 落とし穴

- 合成した PointerEvent の timeStamp は生成時刻になる。pointerdown より前に作った move は重複として捨てられる（ベンチで一度これにハマった）。
- headless での getImageData の読み戻しは数百 ms かかることがある。時間に依存するテスト（パームリジェクションの 500ms）は、イベントを全部撃ってから検証する。
- headless Chromium は SwiftShader（ソフトウェア GPU）で動く。GPU 寄りの処理時間は実機より悲観的に出る。初回だけ遅いのはバッキングの確保が原因（→ warm）。キャンバスの確保は面積に比例して重い。
- ベンチで確定や元に戻すを測る前に、GPU の仕事を吐き出させる（`getImageData(0,0,1,1)` か `api.pixels`）。溜まったままだと、前の処理の分まで次の計測に乗って数倍に見える。@2x は特にばらつきが大きいので、2 回以上流して範囲で書く。
- テストでツールバーの上（画面の上端付近）から描き始めると、pointerdown がツールバーに取られて線が描かれない。継ぎ目の確認で一度「線が消えた」と誤解した。
- 面の画素を確かめるときは、live に残っている線を拾わないように `pixels()`（面だけ）か `screenPixel()`（画面の位置にあるタイル）を使う。確定の直後は live がまだ 2 フレーム残っている。
- この作業環境から *.github.io へはつながらない（ネットワークポリシーで 403）。公開の確認は GitHub API（Actions のジョブ結果）で行う。
- Playwright の mouse で viewport の外（負の座標）からドラッグを始めると、pointerdown がツールに届かない。
- `page.evaluate(CODE)` は CSP を通さずに実行する（Firefox のブックマークレットに相当）。本物の `javascript:` URL として実行するには `location.href = BOOKMARKLET` を使う（CSP のないページでだけ動く）。
- Artifact のビューアはダウンロードをブロックするので、そこでは PNG 保存ボタンが反応しない。
- 取り消し待ちの Ctrl+Z で reopen すると、同じ keydown の途中で onKey が登録される。DOM は配送中に足されたリスナーを呼ばないので、絵の undo までは進まない（テストで確かめている）。順序を変えるときは注意。
- テストで「ページの上にツールがかぶっていない」を見るときは、elementFromPoint が `PAINT-BOOKMARKLET` かどうかで判定する（下にあるのは本文の段落など、場所で変わる）。

## 検証の方法

- `npm test` で見ていること: 起動とトグル・破棄、速い線が途切れない、undo / redo が画素単位で一致、消しゴム（右クリック含む）、半透明の重なり、四角と塗りつぶし（隙間・漏れ）、筆圧、パームリジェクション、ページへのイベント漏れ、入力欄にフォーカスがあるときのショートカット、厳格な CSP と Trusted Types、リサイズ、図形と Shift、PNG 保存、塗りつぶしの壁と再着色、rawupdate と pointermove の重複処理。閉じる: 8 秒後に破棄、ボタン・Ctrl+Z・ブックマークレットで戻る（入力欄の Ctrl+Z は横取りしない）、戻すまでページをクリックできる、何も描いていなければすぐ閉じる。スクロール追従: 描いてからのスクロール、スクロール後の描画と undo / redo（目印の要素との位置）、スクロール後の塗りつぶし・消しゴム・PNG、端に描いてもスクロール範囲が広がらない、ページが縮むと面も縮む、html に余白があるページ、確定時のちらつきと半透明の opacity の事前設定、scroll / wheel リスナーがない、@2x、表示倍率の変更（CDP で dpr 1.5）。
- 未確認: Firefox と Safari での動作、実際のペンタブレット、Windows の Ink Trail、実 GPU での desynchronized の効果、実機でのスクロールの滑らかさ（タイルが多いとき）、Gmail などの内側スクロールのサイトでの見え方。

## 外部の状態

- GitHub: shutsuruwork-afk/paint-tool（public）。ブランチは main と feature/paint-bookmarklet
- Actions: Pages ワークフロー。run 38550725208（05f8ca8）で初めて deploy まで成功。T-003（f88cd16）は run 38595502374 で成功。configure-pages@v5 と deploy-pages@v4 に Node 20 非推奨の警告が出るが、動作はしている
- Pages: 公開中。Source は「GitHub Actions」。URL は https://shutsuruwork-afk.github.io/paint-tool/
- Artifact: https://claude.ai/artifact/Aj3XQxn6Q7EUaiHjYAFbve（インストールページ、非公開）。`docs/index.html` の本文だけの版

## 完了ログ（新しい順）

### T-006 閉じる（×）を押しても、しばらくは絵を元に戻せるようにする — 2026-10-14
- 変更: × を押すと絵とツールバーが消え、画面の下に「絵を消して閉じました［元に戻す］」と残り時間のバーが 8 秒出る。その間はボタン・Ctrl/⌘+Z・ブックマークレットで絵も履歴も戻る。8 秒たつと今までどおりすべて解放する。何も描いていなければすぐ閉じる。API に `close()` を足し、`destroy()` はすぐ解放のまま。版を 1.2.0 にした。README とインストールページに書いた。
- 確認: `npm test` 28 件が通過（2 件追加、1 件を 8 秒後の破棄に変更）。入力欄の判定を外すと、入力欄の Ctrl+Z を横取りしてテストが落ちることを確かめた。お知らせの見た目をスクリーンショットで確かめた。入力のホットパスは変えていないのでベンチは流していない。
- 残課題: 8 秒が短すぎないか・長すぎないかは使用感待ち。隠す（Esc）の状態が分かりにくい件は T-008 のまま。

### T-003 絵をページに貼り付け、スクロールしても一緒に動くようにする — 2026-10-14
- 変更: 確定した絵を、画面固定の main キャンバスから、ページ座標に置いた canvas タイルの「面」へ移した。描いている途中の線は今までどおり画面固定で、確定時に面へ移す。履歴・消しゴム・塗りつぶし・全消去・PNG 保存・コピーを面の座標で動くように書き換えた。確定時のちらつきを受け渡し（2 フレーム後に live を消す）で防ぎ、半透明の線の opacity をツール変更時に先に合わせるようにした。API に `pixels()` を足し、版を 1.1.0 にした。README とインストールページの説明・計測表・できないことを更新し、Artifact も更新した。
- 確認: `npm test` 26 件が通過（10 件追加）。html の位置補正を外すと余白のテストが、clip を外すと端のテストが落ちることを確かめた。タイルの継ぎ目で半透明の線の濃さが変わらないこと（@1x と @1.5x）を画素で確かめた。`npm run bench`: 入力 1 件 5〜8 µs（@2x 4〜14 µs）で悪化なし。確定は @1x 4〜7 ms、@2x 8〜22 ms で、以前より数 ms 重い（初めて描く場所のタイルの確保）。
- 残課題: 内側だけがスクロールするサイト、描画中のスクロール、本文があとから動くずれは範囲外（README の「できないこと」に記載）。実機でのスクロールの滑らかさは未確認で、ユーザーの使用感を待つ。

### T-015 MIT ライセンスを付ける — 2026-10-14
- 変更: LICENSE（MIT、Copyright (c) 2026 shutsuruwork-afk）を追加。package.json の license、README の「ライセンス」節、`src/paint.js` の先頭コメント、インストールページのフッターに MIT を明記した。Artifact も更新した（version 3）。
- 確認: `npm test` 16 件が通過。
- 残課題: 圧縮版（dist/、ブックマークレット）には著作権表示のコメントを入れていない（サイズを優先）。本人の配布なので問題はない。

### T-002 インストールページを GitHub Pages で公開する — 2026-10-14
- 結果: ユーザーが public 化と Source の設定（R-001）を済ませ、run 38550725208 の deploy が成功。公開 URL は https://shutsuruwork-afk.github.io/paint-tool/ （deploy ジョブのログの environment url で確認）。
- 確認できていないこと: 公開ページを直接開いての表示確認（作業環境から github.io につながらないため）。

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
