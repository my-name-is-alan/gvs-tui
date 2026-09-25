// 桌面端替身：tui/src/lib/tool-paths.ts
//   开发：仓库的 tui/bin
//   Windows 安装包：resources/bin（随包带 ffmpeg / N_m3u8DL-RE / mkvmerge / MP4Box）
//   macOS 安装包：用户数据目录下的 bin——tools.ts 会在这里写 Homebrew 包装脚本，
//                 不能写进签名过的 .app 里
import { app } from 'electron'
import { join } from 'node:path'

export function tuiBinDir(): string {
  if (!app.isPackaged) return join(app.getAppPath(), '..', 'bin')
  if (process.platform === 'win32') return join(process.resourcesPath, 'bin')
  return join(app.getPath('userData'), 'bin')
}

export function toolDirectoryFrom(_modulePath: string): string {
  return tuiBinDir()
}
