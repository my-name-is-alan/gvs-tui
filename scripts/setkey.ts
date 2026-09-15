// Point the local TUI config at the deployment with the gateway's dev key.
import { loadConfig, saveConfig, configPath } from '../src/lib/config.ts'

const cfg = loadConfig()
cfg.host = 'https://gvs.videohack.shop'
cfg.key = 'sk_live_dev12345678.devsecretdevsecretdevsecretdevsecret'
saveConfig(cfg)

const check = loadConfig()
console.log('written to:', configPath())
console.log('host:', check.host)
console.log('key :', `${check.key.slice(0, 18)}…${check.key.slice(-6)}`)
console.log('out :', check.outDir, '| group:', check.releaseGroup, '| ffmpeg:', check.ffmpeg)
