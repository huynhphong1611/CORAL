import { useHistory } from '../../api/testcases'
import { Badge, formatTime, QueryState } from '../../components/ui'
import { en } from '../../i18n/en'

/** `Name <email>` → `Name`. */
const authorName = (author: string) => author.replace(/\s*<[^>]*>$/, '')

/** Commits of the test case, newest first: who, when, message (FR-020). */
export function HistoryPanel({ testCaseId, head }: { testCaseId: string; head: string }) {
  const history = useHistory(testCaseId)
  return (
    <QueryState query={history} empty={en.editor.noHistory}>
      {(entries) => (
        <ol className="divide-y divide-slate-100 text-sm" aria-label={en.editor.history}>
          {entries.map((entry) => (
            <li key={entry.commit} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-slate-900">{entry.message}</p>
                <p className="text-xs text-slate-500">
                  {authorName(entry.author)} · {formatTime(entry.created_at)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {entry.commit === head && <Badge tone="green">{en.editor.current}</Badge>}
                <code className="text-xs text-slate-500">{entry.commit.slice(0, 7)}</code>
              </div>
            </li>
          ))}
        </ol>
      )}
    </QueryState>
  )
}
