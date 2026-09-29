import { api } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { keys, useCoral, useProjects, useRole } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import {
  buttonClass,
  errorMessage,
  formatTime,
  inputClass,
  QueryState,
  Table,
  Td,
  Th,
} from '../../components/ui'
import { en } from '../../i18n/en'

/** `/projects`: the tenant's projects; writers create one (FR-003). */
export function ProjectsPage() {
  const projects = useProjects()
  const { canWrite } = useRole()
  return (
    <section>
      <PageHeader title={en.projects.title}>{canWrite && <CreateProject />}</PageHeader>
      <QueryState query={projects} empty={en.projects.empty}>
        {(list) => (
          <Table label={en.projects.title}>
            <thead>
              <tr>
                <Th>{en.projects.name}</Th>
                <Th className="w-56">{en.projects.created}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((project) => (
                <tr key={project.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                      search={{ tab: 'testcases' }}
                      className={buttonClass.link}
                    >
                      {project.name}
                    </Link>
                  </Td>
                  <Td className="text-slate-500">{formatTime(project.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </section>
  )
}

function CreateProject() {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: (projectName: string) =>
      client.post('/projects', { name: projectName }, api.projectSchema),
    onSuccess: async () => {
      setName('')
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: keys.projects })
    },
  })

  if (!open) {
    return (
      <button type="button" className={buttonClass.primary} onClick={() => setOpen(true)}>
        {en.projects.create}
      </button>
    )
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate(name.trim())
  }
  return (
    <form onSubmit={submit} className="flex items-start gap-2" aria-label={en.projects.create}>
      <div className="space-y-1">
        <input
          aria-label={en.projects.name}
          placeholder={en.projects.namePlaceholder}
          required
          maxLength={100}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
        {create.isError && (
          <p role="alert" className="text-xs text-red-700">
            {errorMessage(create.error)}
          </p>
        )}
      </div>
      <button
        type="submit"
        className={buttonClass.primary}
        disabled={create.isPending || !name.trim()}
      >
        {en.projects.createSubmit}
      </button>
      <button type="button" className={buttonClass.secondary} onClick={() => setOpen(false)}>
        {en.common.cancel}
      </button>
    </form>
  )
}
