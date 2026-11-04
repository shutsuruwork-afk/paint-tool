# paint-tool

ブックマークレット製の低遅延ペイントツール。本体は `src/paint.js`（1 ファイルの IIFE）。
`npm run build` で `dist/` と `docs/index.html` を生成し、生成物もコミットする。確認は `npm test`、性能は `npm run bench`。

いまの方針は、遅延と効率を落とさずに使いやすさを上げること。

- 作業はタスクとして `.claude/TASKS.md` に書く（`.claude/rules/tasks.md`）
- タスクを完了したら `.claude/HANDOFF.md` を更新する（`.claude/rules/handoff.md`）
- ユーザーのアイデアは `.human/ideas/`、ユーザーへの判断・作業のお願いは `.human/requests.md`（`.claude/rules/human.md`）
- 表示の版は 2 つ（`.claude/rules/versions.md`）。Simple（cp2）は普通に使うときの既定で、ユーザーの領分（見える物・操作は指示があったときだけ変える）。Beta（main。前の本家）は Claude が好きに開発してよい場所で、作ったらユーザーに見せて承認を取る。開発の決まり: 仕様に一貫性を持たせる・初めて使う人が気持ちよく使える・慣れると空気のように扱える（2026-11-04、ユーザーの指示）
- Simple を触るときは、先に `.claude/HANDOFF-simple.md` を読み、終えたら更新する
- サブエージェント（Agent ツール）を使う前に、ユーザーに確認をとる（2026-10-18、ユーザーの指示）

以下はセッション開始時に自動で読み込まれる。まず「現在地」「進行中」「未対応のお願い」を確認し、`.human/ideas/` に未取り込みのファイルがないかを見てから作業を始める。

@HANDOFF.md
@TASKS.md
@../.human/requests.md
