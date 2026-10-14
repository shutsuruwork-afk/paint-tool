// Stop フック: TASKS.md の「完了」にあるタスク ID が、HANDOFF.md の「完了ログ」に記録されているかを確かめる。
// 漏れていれば停止をブロックして、ハンドオフの更新を促す（.claude/rules/handoff.md）。
// ファイルが読めない・見出しが見つからないなど想定外の状態では何もしない（作業を止めない）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// "## 見出し" の次の行から、次の "## " 見出しの直前までを返す
const section = (md, title) => {
  const lines = md.split('\n');
  const start = lines.findIndex(l => new RegExp(`^## ${title}(\\s|（|\\(|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

try {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { }
  // フックの指摘を受けて続行中なら、二度目は止めない（無限ループ防止）
  if (input.stop_hook_active) process.exit(0);

  const dir = join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), '.claude');
  const done = section(readFileSync(join(dir, 'TASKS.md'), 'utf8'), '完了');
  const log = section(readFileSync(join(dir, 'HANDOFF.md'), 'utf8'), '完了ログ');
  if (done === null || log === null) process.exit(0);

  // 完了の各行の先頭にある ID だけを見る（見出しの中で別タスクに触れていても誤検知しない）
  const ids = [...new Set([...done.matchAll(/^\s*[-*]\s*(T-\d{3,})\b/gm)].map(m => m[1]))];
  const missing = ids.filter(id => !new RegExp(`\\b${id}\\b`).test(log));
  if (missing.length) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `TASKS.md で完了にした ${missing.join(', ')} が .claude/HANDOFF.md の「完了ログ」にありません。` +
        '.claude/rules/handoff.md の手順で HANDOFF.md（現在地・完了ログ・変わった前提）を更新し、TASKS.md と一緒にコミットしてください。',
    }));
  }
} catch { }
process.exit(0);
