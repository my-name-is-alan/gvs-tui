import { BrowserWindow, session } from 'electron'

/**
 * 腾讯视频手机号登录图形验证（防水墙）窗口。
 *
 * 页面是官方 `https://m.v.qq.com/z/app/pic_shield/index.html`（VftShield/TCaptcha，
 * sAppId 2056554487, businessId phone_login）。用户本人在窗口里完成滑块；
 * 成功后页面通过 `TenvideoJSBridge.CallHandler('graphicTicketFinish', json)` 回传
 * {errCode, code, ticket}，同时 SDK 会把 captcha_ticket/captcha_code 写进 cookie。
 *
 * 我们不代过验证、不注入答案：只提供页面期望的原生桥 shim，把用户自己过验得到的
 * ticket/code 转发给调用方（网关发码请求需要它们）。
 *
 * 双保险捕获：
 *   1. dom-ready 后向页面世界注入 TenvideoJSBridge shim，回传走 console 口令
 *      （页面自身只依赖 CallHandler，注入对验证流程零干预）
 *   2. 主进程轮询该 partition 的 captcha_ticket / captcha_code cookie
 * 任一先到即 resolve；两者都到以 bridge 为准（带 errCode）。
 */

const PAGE_URL = 'https://m.v.qq.com/z/app/pic_shield/index.html'
const TIMEOUT_MS = 5 * 60 * 1000
const COOKIE_POLL_MS = 500
/** shim 回传口令：带这个前缀的 console.log 即桥回调 */
const BRIDGE_MARK = '__TENCENT_CAPTCHA_RESULT__'

export const TENCENT_CAPTCHA_PARTITION = 'persist:tencent-captcha'

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 15; PGP110) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36'

export type TencentCaptchaResult = {
  errCode: number
  ticket: string
  code: string
}

export type TencentCaptchaHandle = {
  result: Promise<TencentCaptchaResult>
}

export function openTencentCaptchaWindow(
  log: (msg: string) => void,
  pageUrl: string = PAGE_URL,
): TencentCaptchaHandle {
  let resolveResult: (r: TencentCaptchaResult) => void = () => {}
  const result = new Promise<TencentCaptchaResult>((resolve) => {
    resolveResult = resolve
  })

  const say = (msg: string): void => {
    log(`tencent captcha: ${msg}`)
    console.log(`[tencent-captcha] ${msg}`)
  }

  const part = session.fromPartition(TENCENT_CAPTCHA_PARTITION)
  part.setUserAgent(MOBILE_UA)
  // 清掉上一轮遗留的 captcha cookie：否则轮询会立刻捕获旧 ticket（已过期/已消费）
  void part.clearStorageData({ storages: ['cookies'] }).catch(() => {})

  const win = new BrowserWindow({
    width: 400,
    height: 620,
    show: true,
    title: '腾讯视频 · 图形验证',
    autoHideMenuBar: true,
    webPreferences: {
      partition: TENCENT_CAPTCHA_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  })

  let done = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null

  const finish = (r: TencentCaptchaResult, via: string): void => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    if (poll) clearInterval(poll)
    say(
      `捕获(${via}) errCode=${r.errCode} ticket=${r.ticket ? r.ticket.slice(0, 8) + '…' : '无'} code=${r.code ? r.code.slice(0, 6) + '…' : '无'}`,
    )
    resolveResult(r)
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy()
    }, 1200)
  }

  const failClosed = (errCode: number): void => {
    if (done) return
    finish({ errCode, ticket: '', code: '' }, 'closed')
  }

  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    if (poll) clearInterval(poll)
    failClosed(-3)
  })

  // 捕获路径 2：cookie 轮询（VftShield 成功后写 captcha_ticket/captcha_code）
  poll = setInterval(() => {
    if (done) return
    void part.cookies
      .get({ name: 'captcha_ticket' })
      .then(async (tickets) => {
        if (!tickets.length) return
        const codes = await part.cookies.get({ name: 'captcha_code' })
        if (!codes.length) return
        finish({ errCode: 0, ticket: tickets[0].value, code: codes[0].value }, 'cookie')
      })
      .catch(() => {})
  }, COOKIE_POLL_MS)

  // 捕获路径 1：console 口令（shim 注入后 CallHandler 触发）
  win.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message !== 'string' || !message.startsWith(BRIDGE_MARK)) return
    try {
      const parsed = JSON.parse(message.slice(BRIDGE_MARK.length))
      const errCode = Number(parsed?.errCode ?? 1)
      finish(
        { errCode, ticket: String(parsed?.ticket ?? ''), code: String(parsed?.code ?? '') },
        'bridge',
      )
    } catch {
      say('bridge 消息解析失败')
    }
  })

  // 捕获路径 1 的注入：dom-ready 后进页面世界装桥。graphicTicketFinish 只会在
  // 用户过验之后被调用，此刻注入不会干扰验证过程。
  win.webContents.on('dom-ready', () => {
    void win.webContents
      .executeJavaScript(
        `(function(){
          if (window.__tencentCaptchaShimInstalled) return;
          window.__tencentCaptchaShimInstalled = true;
          var mk = Number(${JSON.stringify(BRIDGE_MARK.length)});
          var mark = ${JSON.stringify(BRIDGE_MARK)};
          var callHandler = function(method, params){
            if (method === 'graphicTicketFinish') {
              try { console.log(mark + String(params)); } catch (e) {}
            }
            return '';
          };
          window.TenvideoJSBridge = window.TenvideoJSBridge || {
            CallHandler: callHandler,
            AddObserver: function(){ return ''; },
          };
          if (!window.external) window.external = {};
        })();`,
        false,
      )
      .then(() => say('bridge shim 已注入'))
      .catch((e: unknown) => say(`shim 注入失败：${String(e).slice(0, 100)}`))
  })

  timer = setTimeout(() => {
    if (!done) {
      say('超时未完成验证')
      finish({ errCode: -7, ticket: '', code: '' }, 'timeout')
    }
  }, TIMEOUT_MS)

  win.webContents.setWindowOpenHandler(({ url }) => {
    say(`window-open 被拒 ${url.slice(0, 80)}`)
    return { action: 'deny' }
  })

  say(`打开图形验证页 ${pageUrl}`)
  void win.loadURL(pageUrl).catch((e: unknown) => {
    say(`loadURL rejected ${String(e).slice(0, 120)}`)
  })

  return { result }
}
