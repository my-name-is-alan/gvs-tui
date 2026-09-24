// Canned snapshots so the whole UI can be rendered without a gateway, a key, or
// a network: `bun run preview` (see scripts/preview.ts) and `GVS_PREVIEW=jobs
// bun run dev`. Data is fictional but shaped exactly like the real payloads.
import type { Audio, Detail, Episode, Job, OptionTab, Quality, Row, Snapshot, StatusKind, TMDBHit } from '../types.ts'

const HOST = 'http://127.0.0.1:8080'

const ROWS: Row[] = [
  { title: '斗破苍穹年番', id: '1234567', sub: 'youku', desc: '萧炎智斗蛇人族', score: '9.1', tags: ['玄幻', '热血', '国产'] },
  { title: '黑棺镇麒麟，老翁御千魂', id: '7679443558306155544', sub: 'hongguo', desc: '玄幻脑洞·全151集', score: '8.0', tags: ['奇幻', '古代', '3D'] },
  { title: '完美世界', id: '2345678', sub: 'tencent', desc: '石昊少年崛起', score: '8.6', tags: ['玄幻', '国漫'] },
  { title: '遮天', id: '3456789', sub: 'hongguo', desc: '仙侠·全120集', score: '8.4', tags: ['仙侠', '3D'] },
  { title: '吞噬星空', id: '4567890', sub: 'tencent', desc: '罗峰闯宇宙', score: '8.8', tags: ['科幻', '国漫'] },
  { title: '凡人修仙传', id: '5678901', sub: 'hongguo', desc: '仙侠·全180集', score: '9.2', tags: ['仙侠', '修仙'] },
  { title: '仙逆', id: '6789012', sub: 'youku', desc: '王林证道', score: '8.9', tags: ['仙侠'] },
  { title: '斗罗大陆 II 绝世唐门', id: '7890123', sub: 'tencent', desc: '霍雨浩成长', score: '8.3', tags: ['玄幻'] },
  { title: '剑来', id: '8901234', sub: 'hongguo', desc: '武侠·全60集', score: '8.7', tags: ['武侠'] },
  { title: '大奉打更人', id: '9012345', sub: 'tencent', desc: '许七安断案', score: '8.5', tags: ['古装'] },
  { title: '沧元图', id: '0123456', sub: 'youku', desc: '孟川修行记', score: '8.2', tags: ['东方'] },
  { title: '神墓', id: '1122334', sub: 'hongguo', desc: '玄幻·全80集', score: '7.9', tags: ['玄幻'] },
]

function episodes(count: number, selected: number[]): Episode[] {
  const picked = new Set(selected)
  return Array.from({ length: count }, (_, i) => ({
    title: `守墓三十年的孙老六，在无归岗意外救出被封三百年的墨麒麟墨玄。面对神兽报恩，他不要黄金富贵，只求救女儿阿宁。`,
    vid: `vid_${(i + 1).toString().padStart(4, '0')}`,
    number: i + 1,
    selected: picked.has(i + 1),
    duration: 40 + ((i * 7) % 260),
  }))
}

const DETAIL: Detail = {
  title: '黑棺镇麒麟，老翁御千魂',
  desc: '守墓三十年的孙老六，在无归岗意外救出被封三百年的墨麒麟墨玄。面对神兽报恩，他不要黄金富贵，只求救女儿阿宁。一次善举，却牵出麒麟王族旧案与惊天阴谋。危难之际，孙老六多年埋下的善意化作千灯回应，最终千坟齐亮、万灵报恩。',
  category: '奇幻短剧',
  tags: ['奇幻', '古代', '乡村', '3D'],
  score: '8.0',
  episodes: 151,
  duration: 302,
  vip: false,
  drm: 'CENC 加密，下载后本机解密',
  kind: 'show',
  year: 0,
}

const QUALITY_YOUKU: Quality[] = [
  { id: 'cmfv5hd4_dolbyvision_hfr_hbr_hq', label: '杜比视界', title: 'dolbyvision', size: 22_242_398_286, width: 3840, height: 1608, codec: 'DVH1', drm: 'copyrightDRM' },
  { id: 'cmfv5hd4_hdrvivid_hfr_hbr_hq', label: 'HDR Vivid', title: 'hdrvivid', size: 17_197_040_024, width: 3840, height: 1608, codec: 'HVC1', drm: 'copyrightDRM' },
  { id: 'cmfv5hd4_hdr_hfr_hbr_hq', label: 'HDR10', title: 'hdr10', size: 17_197_040_024, width: 3840, height: 1608, codec: 'HVC1', drm: 'copyrightDRM' },
  { id: 'cmfv5hd4_sdr_hfr_hbr_bit10_hq', label: 'SDR', title: 'sdr', size: 17_034_565_201, width: 3840, height: 1608, codec: 'HVC1', drm: 'copyrightDRM' },
  { id: 'hls5hd4_hdr_hfr_hbr', label: '4K', title: 'hls5hd4', size: 7_236_077_324, width: 3840, height: 1608, codec: 'H265', drm: 'copyrightDRM' },
  { id: 'mp4hd3', label: '1080P', title: 'mp4hd3', size: 740_901_420, width: 1920, height: 808, codec: 'H264', drm: 'copyrightDRM' },
  { id: 'mp5hd3', label: '1080P', title: 'mp5hd3', size: 548_627_240, width: 1920, height: 808, codec: 'H265', drm: 'copyrightDRM' },
  { id: 'mp4hd2', label: '720P', title: 'mp4hd2', size: 412_531_596, width: 1280, height: 536, codec: 'H264', drm: 'copyrightDRM' },
  { id: 'mp5hd2', label: '720P', title: 'mp5hd2', size: 282_560_240, width: 1280, height: 536, codec: 'H265', drm: 'copyrightDRM' },
  { id: 'mp4hd', label: '480P', title: 'mp4hd', size: 247_400_104, width: 864, height: 362, codec: 'H264', drm: 'copyrightDRM' },
  { id: 'flvhd', label: '360P', title: 'flvhd', size: 157_854_952, width: 640, height: 268, codec: 'H264', drm: 'copyrightDRM' },
]

const AUDIOS: Audio[] = [
  { id: 'cmfa1hd3', label: 'AAC', lang: '国语', codec: 'cmfa1hd3', isDefault: true, selected: true },
  { id: 'cmfa2hd3', label: '杜比全景声', lang: '国语', codec: 'cmfa2hd3', isDefault: false, selected: true },
  { id: 'cmfa3hd3', label: 'DTS:X', lang: '原声', codec: 'cmfa3hd3', isDefault: false, selected: false },
]

const QUALITIES: Quality[] = [
  { id: '1080p', label: '1080P', title: '1080P', size: 336_068_608, width: 1920, height: 1080, codec: 'H265', drm: 'CENC' },
  { id: '720p', label: '720P', title: '720P', size: 189_005_824, width: 1280, height: 720, codec: 'H265', drm: 'CENC' },
  { id: '540p', label: '540P', title: '540P', size: 92_274_688, width: 960, height: 540, codec: 'H264', drm: '' },
  { id: '360p', label: '360P', title: '360P', size: 41_943_040, width: 640, height: 360, codec: 'H264', drm: '' },
]

const TMDB: TMDBHit[] = [
  { id: 34567, name: '斗破苍穹 年番', title: '斗破苍穹 年番', year: 2024, overview: '萧炎重返加玛帝国，为药老炼制躯体，与云岚宗正面碰撞。' },
  { id: 98765, name: '斗破苍穹', title: '斗破苍穹', year: 2017, overview: '少年萧炎从天之骄子跌落凡尘，三年后再启炼药之路。' },
  { id: 55667, name: '斗破苍穹 缘起', title: '斗破苍穹 缘起', year: 2022, overview: '特别篇：萧炎与药老的初遇。' },
]

const JOBS: Job[] = [
  { id: 1, title: '斗破苍穹年番 E01 1080P', status: '完成', pct: 1, log: 'D:\\downloads\\斗破苍穹年番\\S01E01.mkv', err: '' },
  { id: 2, title: '斗破苍穹年番 E02 1080P', status: '下载', pct: 0.43, log: '12.4 MB/s', err: '' },
  { id: 3, title: '斗破苍穹年番 E03 1080P', status: '封装', pct: 0.92, log: '封装 420 MB/680 MB', err: '' },
  { id: 4, title: '斗破苍穹年番 E04 1080P', status: '排队', pct: 0, log: '', err: '' },
  { id: 5, title: '完美世界 E118 720P', status: '失败', pct: 0, log: '', err: '腾讯没有 video.url' },
]

const SETTINGS = [
  { label: '隧道', value: '已连接 · 优酷/腾讯走本机 IP · WebSocket' },
  { label: '网关', value: HOST },
  { label: 'Key', value: '演示模式，无需 Key' },
  { label: '下载目录', value: 'D:\\downloads' },
  { label: '下载线程', value: '4 路并发' },
  { label: '发布组', value: 'ADWeb' },
  { label: 'TMDB Key', value: '已配置' },
  { label: '优酷扫码', value: '扫码把登录态写进本机' },
  { label: '优酷登录', value: '可续期 · 上次续期 3 分钟前 · 酷友福克纳君的杏花 · uid 2223055214990 · 非 VIP' },
  { label: '腾讯 Cookie', value: '空 · 回车粘贴' },
  { label: '红果合并', value: '开' },
  { label: '红果 NFO', value: '开' },
  { label: '红果封装', value: 'mkv' },
]

/** A deterministic stand-in for a scannable QR block, sized like a real one. */
function fakeQR(size = 25): string {
  const lines: string[] = []
  for (let y = 0; y < size; y++) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const finder =
        (x < 7 && y < 7 && (x === 0 || y === 0 || x === 6 || y === 6 || (x > 1 && x < 5 && y > 1 && y < 5))) ||
        (x > size - 8 && y < 7 && (x === size - 1 || y === 0 || x === size - 7 || y === 6 || (x > size - 6 && x < size - 2 && y > 1 && y < 5))) ||
        (x < 7 && y > size - 8 && (x === 0 || y === size - 1 || x === 6 || y === size - 7 || (x > 1 && x < 5 && y > size - 6 && y < size - 2)))
      const data = (x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0
      line += finder || data ? '██' : '  '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const BASE: Omit<Snapshot, 'scene'> = {
  host: HOST,
  status: '',
  statusKind: 'info' as StatusKind,
  busy: false,
  tunnelOk: true,
  tunnelTransport: 'ws' as const,
  ykAccount: {
    loggedIn: true,
    needsScan: false,
    nick: '酷友福克纳君的杏花',
    uid: '2223055214990',
    method: 'qr',
    vipSource: 'login' as const,
    isVip: true,
    vipUntil: '',
    riskLevel: 'none',
    summary: '酷友福克纳君的杏花 · uid 2223055214990 · 已登录(qr) · 会员（扫码时确认）',
  },
  cursor: 0,
  providerIndex: 0,
  qualityIndex: 0,
  audioIndex: 0,
  optionTab: 'quality',
  probeFailed: false,
  providers: ['hongguo', 'youku', 'tencent', 'douyin'],
  homeItems: ['粘贴链接', '搜索', '榜单', '任务', '设置'],
  rows: [],
  episodes: [],
  qualities: [],
  audios: [],
  tmdbHits: [],
  jobs: [],
  settings: SETTINGS,
  hostInput: HOST,
  hostFocused: true,
  keyFocused: false,
  keyConfigured: true,
  detailTitle: '',
  pendingCount: 0,
  query: '',
  editField: '',
  editValue: '',
  qrAscii: '',
}

/** Build a realistic snapshot for one scene. `cursor` moves the highlight. */
export function demoSnapshot(scene: string, cursor = 0): Snapshot {
  const s: Snapshot = { ...BASE, scene, cursor }
  switch (scene) {
    case 'setup':
      return { ...s, scene, status: '', statusKind: 'info', tunnelOk: false, keyConfigured: false, hostInput: '', keyFocused: true, hostFocused: false }
    case 'search':
      return { ...s, scene, providerIndex: 0, query: '斗破苍穹', status: '粘贴分享链接后查看内容，再确认下载', statusKind: 'info' }
    case 'results':
      return { ...s, scene, rows: ROWS, cursor, status: `${ROWS.length} 条结果`, statusKind: 'info' }
    case 'detail':
      return { ...s, scene, detailTitle: '黑棺镇麒麟，老翁御千魂', detail: DETAIL, episodes: episodes(151, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), cursor, status: '已选 12 集', statusKind: 'info' }
    case 'quality':
      return {
        ...s, scene, detailTitle: '斗破苍穹年番', detail: { ...DETAIL, title: '斗破苍穹年番', category: '电影', score: '9.1', episodes: 4, duration: 4910, vip: true },
        qualities: QUALITY_YOUKU, audios: AUDIOS, qualityIndex: cursor, audioIndex: 0,
        optionTab: (process.env.GVS_PREVIEW_TAB === 'audio' ? 'audio' : 'quality') as OptionTab,
        pendingCount: 4, cursor: 0, status: '11 档画质 · 3 条音轨 · 4 集 · 可播', statusKind: 'ok',
        vipProbe: { canPlay: true, isVip: true, hasTrial: false, download: '["allowed"]', note: '' },
      }
    case 'tmdb':
      return { ...s, scene, detailTitle: '斗破苍穹年番', tmdbHits: TMDB, cursor, pendingCount: 12, status: '找到 3 个候选', statusKind: 'info' }
    case 'jobs':
      return { ...s, scene, jobs: JOBS, status: '已加入 2 个任务', statusKind: 'ok' }
    case 'settings':
      return { ...s, scene, cursor, status: '', statusKind: 'info' }
    case 'edit':
      return { ...s, scene, editField: '下载目录', editValue: 'D:\\downloads' }
    case 'qr':
      return { ...s, scene, qrAscii: fakeQR(), status: '本机网关，扫码从家庭 IP 出去', statusKind: 'info' }
    case 'workspace':
    case 'workspace-loading':
    case 'workspace-long-title':
    case 'workspace-empty':
    case 'workspace-error':
    case 'workspace-no-access':
    case 'filters':
    case 'confirm':
    case 'help':
    case 'job-detail':
    case 'home':
    default:
      return { ...s, scene: scene.startsWith('workspace')||scene==='home'?'workspace':scene, cursor, status:'', providers:scene==='workspace-no-access'?[]:s.providers,
 workspace:{provider:'hongguo',mode:'rank',sections:[{id:'hot',title:'热播榜',mode:'rank',contentType:'rank',available:true,filters:[{key:'genre',title:'体裁',options:[{value:'all',label:'全部'},{value:'human',label:'真人'},{value:'comic',label:'漫剧'}]}]},{id:'new',title:'新剧榜',mode:'rank',contentType:'rank',available:true}],sectionIndex:0,focus:'list',rows:['workspace-empty','workspace-loading','workspace-error','workspace-no-access'].includes(scene)?[]:ROWS.map((r,i)=>({...r,title:scene==='workspace-long-title'?'很长的中文节目标题与特别篇说明'.repeat(8):r.title,rank:i+1})),cursor,more:false,loading:scene==='workspace-loading',error:scene==='workspace-error'?'连接失败，请检查网关后按 R 重试':'',notice:scene==='workspace-no-access'?'当前 Key 没有可浏览的平台':'',source:'离线演示 · 非真实榜单',category:'热播榜',compatibility:false,filters:{}},
 confirmation:{title:'长安夜雨（演示）',episodes:'1, 2, 3',quality:'1080P',audio:'国语 AAC',directory:'D:/downloads',name:'长安夜雨.S01E01.1080p.WEB-DL'},jobDetailLines:['演示任务','失败：连接超时',...Array.from({length:60},(_,i)=>`诊断日志 ${i+1} · 不含敏感 URL`)], logOffset:cursor }
  }
}

export const DEMO_SCENES = [
  'workspace','workspace-long-title','workspace-loading','workspace-empty','workspace-error','workspace-no-access','filters','confirm','help','job-detail', 'setup', 'home', 'search', 'results', 'detail', 'quality', 'tmdb', 'jobs', 'settings', 'edit', 'qr',
]
