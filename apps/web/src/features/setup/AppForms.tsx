import { api } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { keys, useCoral } from '../../api/queries'
import { buttonClass, errorMessage, inputClass } from '../../components/ui'
import { en } from '../../i18n/en'

/** Adds an Android app to the project (US7): its name and package. */
export function NewAppForm({ projectId }: { projectId: string }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [pkg, setPkg] = useState('')
  const [problem, setProblem] = useState<string | undefined>()
  const create = useMutation({
    mutationFn: (body: api.CreateApp) =>
      client.post(`/projects/${projectId}/apps`, body, api.appSchema),
    onSuccess: () => {
      setName('')
      setPkg('')
      void queryClient.invalidateQueries({ queryKey: keys.apps(projectId) })
    },
    onError: (error) => setProblem(errorMessage(error)),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const body = api.createAppSchema.safeParse({
      platform: 'android',
      package_or_bundle_id: pkg.trim(),
      name,
    })
    if (!body.success) {
      setProblem(en.apps.badPackage)
      return
    }
    setProblem(undefined)
    create.mutate(body.data)
  }

  return (
    <form
      onSubmit={submit}
      aria-label={en.apps.newApp}
      className="flex flex-wrap items-end gap-3 text-sm"
    >
      <label className="space-y-1">
        <span className="block font-medium">{en.apps.name}</span>
        <input
          className={inputClass}
          value={name}
          required
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="block font-medium">{en.apps.packageId}</span>
        <input
          className={`${inputClass} font-mono`}
          value={pkg}
          required
          placeholder={en.apps.packagePlaceholder}
          onChange={(e) => setPkg(e.target.value)}
        />
      </label>
      <button type="submit" className={buttonClass.primary} disabled={create.isPending}>
        {create.isPending ? en.apps.creating : en.apps.create}
      </button>
      {problem && (
        <p role="alert" className="w-full text-red-700">
          {problem}
        </p>
      )}
    </form>
  )
}

/** Uploads an APK build of an app, with its progress (US7); 413 says the server's limit. */
export function UploadBuild({ app }: { app: api.App }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const fileId = useId()
  const [version, setVersion] = useState('')
  const [file, setFile] = useState<File | undefined>()
  const [percent, setPercent] = useState<number | undefined>()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>()
  const upload = useMutation({
    mutationFn: ({ file: apk, version: v }: { file: File; version: string }) => {
      const form = new FormData()
      form.set('version', v)
      form.set('file', apk, apk.name)
      setPercent(0)
      return client.upload(`/apps/${app.id}/builds`, form, api.buildSchema, (sent, total) =>
        setPercent(Math.round((sent / total) * 100)),
      )
    },
    onSuccess: (build) => {
      setMessage({ ok: true, text: en.apps.uploadedBuild(build.version) })
      setVersion('')
      setFile(undefined)
      void queryClient.invalidateQueries({ queryKey: keys.builds(app.id) })
    },
    onError: (error) =>
      setMessage({
        ok: false,
        text:
          error instanceof ApiError && error.status === 413
            ? en.apps.tooLarge
            : errorMessage(error),
      }),
    onSettled: () => setPercent(undefined),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!file?.name.toLowerCase().endsWith('.apk')) {
      setMessage({ ok: false, text: en.apps.notApk })
      return
    }
    setMessage(undefined)
    upload.mutate({ file, version: version.trim() })
  }

  return (
    <form
      onSubmit={submit}
      aria-label={en.apps.uploadBuild(app.name)}
      className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3 text-sm"
    >
      <label className="space-y-1">
        <span className="block font-medium">{en.apps.version}</span>
        <input
          className={`${inputClass} w-28 font-mono`}
          value={version}
          required
          placeholder={en.apps.versionPlaceholder}
          onChange={(e) => setVersion(e.target.value)}
        />
      </label>
      <div className="space-y-1">
        <label htmlFor={fileId} className="block font-medium">
          {en.apps.file}
        </label>
        <input
          id={fileId}
          key={file ? 'chosen' : 'empty'}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="text-sm"
          onChange={(e) => setFile(e.target.files?.[0])}
        />
      </div>
      <button type="submit" className={buttonClass.secondary} disabled={upload.isPending}>
        {upload.isPending ? en.apps.uploading(percent ?? 0) : en.apps.upload}
      </button>
      {percent !== undefined && (
        <div
          role="progressbar"
          aria-label={en.apps.uploadBuild(app.name)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded bg-slate-100"
        >
          <div className="h-full bg-slate-900 transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`w-full ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}
        >
          {message.text}
        </p>
      )}
    </form>
  )
}
