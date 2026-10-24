import {expect,test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkvmergeTrackFiles} from './mkvmerge.ts'
import {ensureFFmpeg,ensureMkvmerge} from './tools.ts'
import {validateVideoDecode} from './ffmpeg.ts'
const mediaTest=process.env.GVS_MEDIA_TESTS==='1'?test:test.skip
mediaTest('independent RE tracks preserve audio and subtitle language when RE produces no MKV',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gvs-re-track-mux-'))
  try {
    const ff=await ensureFFmpeg(), mkv=await ensureMkvmerge()
    const video=join(root,'download.mp4'),audio=join(root,'download.en.m4a'),sub=join(root,'download.zh-Hant.copy.srt'),out=join(root,'result.mkv')
    const args=['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=64x64:r=12:d=0.4','-f','lavfi','-i','sine=sample_rate=48000:duration=0.4','-map','0:v','-c:v','libx264',video,'-map','1:a','-c:a','aac',audio]
    const made=spawnSync(ff,args,{windowsHide:true,encoding:'utf8',timeout:10000})
    if(made.status!==0)throw new Error(made.stderr)
    writeFileSync(sub,'1\n00:00:00,000 --> 00:00:00,300\n繁體中文字幕\n')
    const seen:number[]=[]
    await mkvmergeTrackFiles(mkv,[video,audio,sub],out,(n)=>seen.push(n))
    expect(await validateVideoDecode(ff,out,undefined,{requireAudio:true})).toEqual([])
    const probe=spawnSync(mkv,['-J',out],{windowsHide:true,encoding:'utf8',timeout:10000})
    const tracks=JSON.parse(probe.stdout).tracks
    expect(tracks.map((t:any)=>t.type).sort()).toEqual(['audio','subtitles','video'])
    const subtitle=tracks.find((t:any)=>t.type==='subtitles')
    expect(subtitle.properties.language_ietf).toBe('zh-Hant')
    expect(subtitle.properties.default_track).toBe(false)
    expect(tracks.find((t:any)=>t.type==='audio').properties.language_ietf).toBe('en')
    expect(seen.some(n=>n>0)).toBe(true)
    const missing=join(root,'no-audio.mkv')
    await expect(mkvmergeTrackFiles(mkv,[video,sub],missing)).rejects.toThrow('缺少')
    expect(existsSync(missing)).toBe(false)
  } finally {rmSync(root,{recursive:true,force:true})}
},30000)

mediaTest('matched original language corrects only single unknown or generic English embedded audio, without changing packets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gvs-original-audio-mux-'))
  try {
    const ff=await ensureFFmpeg(),mkv=await ensureMkvmerge()
    const identify=(path:string)=>{
      const p=spawnSync(mkv,['-J',path],{windowsHide:true,encoding:'utf8',timeout:10000})
      if(p.status!==0)throw new Error(p.stderr)
      return JSON.parse(p.stdout).tracks as Array<{type:string;properties:{language_ietf:string;default_track:boolean}}>
    }
    const hashes=(path:string)=>{
      const p=spawnSync(ff,['-nostdin','-v','error','-i',path,'-map','0:v','-map','0:a','-c','copy','-f','streamhash','-hash','sha256','-'],{windowsHide:true,encoding:'utf8',timeout:10000})
      if(p.status!==0)throw new Error(p.stderr)
      return p.stdout.trim()
    }
    for(const [language,count,fallback,expected] of [
      ['eng',1,'zh',['zh']],['und',1,'zh',['zh']],
      ['jpn',1,'zh',['ja']],['eng',1,'',['en']],
      ['eng',2,'zh',['en','en']],
    ] as const){
      const input=join(root,`source-${language}-${count}-${fallback}.mkv`),out=input+'.out.mkv'
      const args=['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=64x64:r=12:d=0.4','-f','lavfi','-i','sine=sample_rate=48000:duration=0.4','-map','0:v','-map','1:a']
      if(count===2)args.push('-map','1:a')
      args.push('-c:v','libx264','-c:a','aac','-metadata:s:a',`language=${language}`,input)
      const made=spawnSync(ff,args,{windowsHide:true,encoding:'utf8',timeout:10000})
      if(made.status!==0)throw new Error(made.stderr)
      const before=hashes(input)
      await mkvmergeTrackFiles(mkv,[input],out,undefined,undefined,fallback)
      const tracks=identify(out),audio=tracks.filter(t=>t.type==='audio')
      expect(tracks.filter(t=>t.type==='video')).toHaveLength(1)
      expect(audio.map(t=>t.properties.language_ietf)).toEqual([...expected])
      expect(audio.filter(t=>t.properties.default_track)).toHaveLength(1)
      expect(hashes(out)).toBe(before)
    }
  } finally {rmSync(root,{recursive:true,force:true})}
},30000)

mediaTest('original locale also tags the video track, matching other platforms',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gvs-video-lang-'))
  try {
    const ff=await ensureFFmpeg(),mkv=await ensureMkvmerge()
    const video=join(root,'download.mp4'),audio=join(root,'download.m4a'),out=join(root,'result.mkv')
    const made=spawnSync(ff,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=64x64:r=12:d=0.4','-f','lavfi','-i','sine=sample_rate=48000:duration=0.4','-map','0:v','-c:v','libx264',video,'-map','1:a','-c:a','aac',audio],{windowsHide:true,encoding:'utf8',timeout:10000})
    if(made.status!==0)throw new Error(made.stderr)
    await mkvmergeTrackFiles(mkv,[video,audio],out,undefined,undefined,'ja-JP')
    const tracks=JSON.parse(spawnSync(mkv,['-J',out],{windowsHide:true,encoding:'utf8',timeout:10000}).stdout).tracks
    expect(tracks.find((t:any)=>t.type==='video').properties.language_ietf).toBe('ja-JP')
    expect(tracks.find((t:any)=>t.type==='audio').properties.language_ietf).toBe('ja-JP')
  } finally {rmSync(root,{recursive:true,force:true})}
},30000)
