import { PageHeader } from '../components/Layout'
import { en } from '../i18n/en'

/** A signed-in page whose screen lands in a later task (US1+). */
export function Placeholder({ title }: { title: string }) {
  return (
    <section>
      <PageHeader title={title} />
      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        {en.common.comingSoon}
      </p>
    </section>
  )
}
