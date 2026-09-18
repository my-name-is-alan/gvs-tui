import type { DlTask } from './jobs'
export class DownloadDraft {
  tasks: DlTask[] = []
  private consumed = false
  set(tasks: DlTask[]) {
    this.tasks = tasks.map((t) => ({ ...t }))
    this.consumed = false
  }
  take() {
    if (this.consumed) return []
    this.consumed = true
    const tasks = this.tasks
    this.tasks = []
    return tasks
  }
  clear() {
    this.tasks = []
    this.consumed = false
  }
}
