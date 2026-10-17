# paint-tool

ブックマークレット製の低遅延ペイントツール。本体は `src/paint.js`（1 ファイルの IIFE）。
`npm run build` で `dist/` と `docs/index.html` を生成し、生成物もコミットする。確認は `npm test`、性能は `npm run bench`。

いまの方針は、遅延と効率を落とさずに使いやすさを上げること。

- 作業はタスクとして `.claude/TASKS.md` に書く（`.claude/rules/tasks.md`）
- タスクを完了したら `.claude/HANDOFF.md` を更新する（`.claude/rules/handoff.md`）
- ユーザーのアイデアは `.human/ideas/`、ユーザーへの判断・作業のお願いは `.human/requests.md`（`.claude/rules/human.md`）
- Simple（Preview。表示の版 cp2）を触るときは、先に `.claude/HANDOFF-simple.md` を読み、終えたら更新する

以下はセッション開始時に自動で読み込まれる。まず「現在地」「進行中」「未対応のお願い」を確認し、`.human/ideas/` に未取り込みのファイルがないかを見てから作業を始める。

@HANDOFF.md
@TASKS.md
@../.human/requests.md
