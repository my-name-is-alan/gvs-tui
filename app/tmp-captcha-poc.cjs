// 独立 PoC：加载腾讯图形验证窗口，验证渲染+捕获。不进 app 构建。
const { app } = require('electron')
const path = require('path')
// 直接用源码逻辑的等价内联版（避免 TS 编译），行为与 tencent-captcha-window.ts 一致
const { BrowserWindow, session } = require('electron')

const PAGE_URL = 'https://m.v.qq.com/z/app/pic_shield/index.html'
const MARK = '__TENCENT_CAPTCHA_RESULT__'
const PARTITION = 'persist:tencent-captcha-poc'
const UA =
  'Mozilla/5.0 (Linux; Android 15; PGP110) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36'

app.whenReady().then(() => {
  const part = session.fromPartition(PARTITION)
  part.setUserAgent(UA)
  part.clearStorageData({ storages: ['cookies'] }).catch(() => {})
  let done = false
  const win = new BrowserWindow({
    width: 400,
    height: 620,
    show: true,
    title: 'PoC 腾讯图形验证',
    webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const finish = (r, via) => {
    if (done) return
    done = true
    console.log(`[POC] 捕获(${via}) errCode=${r.errCode} ticket_len=${r.ticket.length} code_len=${r.code.length}`)
    if (r.ticket) console.log('[POC] ticket 前12:', r.ticket.slice(0, 12))
    // 完整票据仅落 0600 本地文件（路径由 TX_CAPTCHA_OUT 指定），不打进日志
    const out = process.env.TX_CAPTCHA_OUT
    if (out && r.ticket) {
      try {
        require('fs').writeFileSync(out, JSON.stringify({ errCode: r.errCode, ticket: r.ticket, code: r.code, via, at: Date.now() }, null, 1), { mode: 0o600 })
        console.log('[POC] ticket.json 已写出:', out)
      } catch (e) {
        console.log('[POC] ticket.json 写出失败:', String(e).slice(0, 80))
      }
    }
    setTimeout(() => app.quit(), 800)
  }
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (typeof msg === 'string' && msg.startsWith(MARK)) {
      try {
        const p = JSON.parse(msg.slice(MARK.length))
        finish({ errCode: Number(p.errCode ?? 1), ticket: String(p.ticket ?? ''), code: String(p.code ?? '') }, 'bridge')
      } catch {}
    }
  })
  win.webContents.on('dom-ready', () => {
    win.webContents
      .executeJavaScript(
        `(function(){ if(window.__s) return; window.__s=1;
         window.TenvideoJSBridge = window.TenvideoJSBridge || { CallHandler: function(m,p){ if(m==='graphicTicketFinish'){ try{console.log(${JSON.stringify(MARK)}+String(p));}catch(e){} } return ''; }, AddObserver: function(){return '';} };
         if(!window.external) window.external={}; })();`,
        false,
      )
      .then(() => console.log('[POC] shim 已注入'))
      .catch((e) => console.log('[POC] shim 失败', String(e).slice(0, 120)))
    setTimeout(() => {
      win.webContents
        .executeJavaScript(
          `JSON.stringify({vft: !!window.VftShield, bridgeHooked: !!(window.TenvideoJSBridge && window.TenvideoJSBridge.CallHandler), shieldState: typeof window.VftShield !== 'undefined' ? 'loaded' : 'missing'})`,
          false,
        )
        .then((s) => console.log('[POC] 页面状态:', s))
        .catch(() => {})
    }, 4000)
  })
  const poll = setInterval(() => {
    part.cookies
      .get({ name: 'captcha_ticket' })
      .then(async (t) => {
        if (!t.length) return
        const c = await part.cookies.get({ name: 'captcha_code' })
        if (c.length) finish({ errCode: 0, ticket: t[0].value, code: c[0].value }, 'cookie')
      })
      .catch(() => {})
  }, 500)
  win.on('closed', () => {
    clearInterval(poll)
    setTimeout(() => app.quit(), 300)
  })
  console.log('[POC] 打开', PAGE_URL)
  win.loadURL(PAGE_URL).catch((e) => console.log('[POC] loadURL', String(e).slice(0, 120)))
})
