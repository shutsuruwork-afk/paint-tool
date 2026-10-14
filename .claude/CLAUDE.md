# paint-tool

ブックマークレット製の低遅延ペイントツール。本体は `src/paint.js`（1 ファイルの IIFE）。
`npm run build` で `dist/` と `docs/index.html` を生成し、生成物もコミットする。確認は `npm test`、性能は `npm run bench`。

いまの方針は、遅延と効率を落とさずに使いやすさを上げること。

- 作業はタスクとして `.claude/TASKS.md` に書く（`.claude/rules/tasks.md`）
- タスクを完了したら `.claude/HANDOFF.md` を更新する（`.claude/rules/handoff.md`）

以下の 2 つはセッション開始時に自動で読み込まれる。まず「現在地」と「進行中」を確認してから作業を始める。

@HANDOFF.md
@TASKS.md
