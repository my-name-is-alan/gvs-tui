// bun run scripts/check-audio-timing.ts FILE
import { ensureFFmpeg } from '../src/lib/tools.ts'
import { assertAudioContinuity, inspectMediaTiming } from '../src/lib/media-timing.ts'
const file = process.argv[2]
if (!file) throw new Error('Usage: check-audio-timing.ts FILE')
const tracks = await inspectMediaTiming(await ensureFFmpeg(), file)
assertAudioContinuity(tracks)
console.log(JSON.stringify(tracks, null, 2))
