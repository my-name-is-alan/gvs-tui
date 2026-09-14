package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var (
	infoS  = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	warnS  = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	errS   = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	muteS  = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	titleS = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
	okS    = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	badS   = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	selS   = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Background(lipgloss.Color("22"))
	rowS   = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	idS    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	barS   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
)

func logI(s string) string { return infoS.Render("[I]") + "  " + s }
func logW(s string) string { return warnS.Render("[W]") + "  " + s }
func logE(s string) string { return errS.Render("ERROR") + "  " + s }

func (m model) View() string {
	return m.header() + "\n" + m.body() + "\n" + m.footer()
}

func (m model) header() string {
	tun := muteS.Render("隧道未连")
	if m.tunnelOK {
		tun = okS.Render("隧道已连")
	} else if m.tunnelErr != "" {
		tun = badS.Render("隧道断开")
	}
	line := infoS.Render("[I]") + "  GVS  " + m.cfg.Host + "  " + tun
	if g := strings.TrimSpace(m.cfg.ReleaseGroup); g != "" {
		line += "  " + muteS.Render("-"+g)
	}
	if m.status != "" {
		line += "\n" + muteS.Render("[I]") + "  " + m.status
	}
	return line + "\n"
}

func (m model) footer() string {
	switch m.sc {
	case scSetup:
		return muteS.Render("Tab 切换    Enter 进入")
	case scHome:
		return muteS.Render("j/k 移动    Enter 打开    q 退出")
	case scSearch:
		return muteS.Render("←/→ 平台    Enter 搜索    Esc 返回")
	case scResults, scTMDB:
		return muteS.Render("j/k 移动    Enter 确认    Esc 返回")
	case scDetail:
		return muteS.Render("方向键    空格勾选    a全选    c清空    d下选中    A全集    Enter本集")
	case scQuality:
		return muteS.Render("j/k 选择画质    Enter 下载    Esc 返回")
	case scJobs:
		return muteS.Render("Esc 返回")
	case scSettings:
		return muteS.Render("j/k 移动    Enter 修改    空格 开关    Esc 返回")
	case scQR:
		return muteS.Render("手机扫码    Esc 取消")
	case scEdit:
		return muteS.Render("Enter 保存    Esc 取消")
	}
	return ""
}

func (m model) body() string {
	switch m.sc {
	case scSetup:
		return "网关地址和 API Key\n\n网关\n" + m.hostIn.View() + "\n\nKey\n" + m.keyIn.View()
	case scHome:
		return listView(m.homeItems(), m.cursor, m.listH())
	case scSearch:
		ps := m.providers()
		cur := ""
		if m.provIdx < len(ps) {
			cur = ps[m.provIdx]
		}
		chips := make([]string, len(ps))
		for i, p := range ps {
			if i == m.provIdx {
				chips[i] = titleS.Render(p)
			} else {
				chips[i] = muteS.Render(p)
			}
		}
		return logI("平台  "+strings.Join(chips, "  ")) + "\n" + logI("当前  "+cur) + "\n\n" + m.qIn.View()
	case scResults:
		lines := make([]string, len(m.rows))
		for i, r := range m.rows {
			lines[i] = clip(r.Title, 48) + "  " + idS.Render(r.ID)
		}
		return listView(lines, m.cursor, m.listH())
	case scDetail:
		return m.epGridView()
	case scQuality:
		return m.qualityTable()
	case scTMDB:
		lines := make([]string, len(m.tmdbHits))
		for i, h := range m.tmdbHits {
			lines[i] = h.display()
		}
		return logI("匹配 TMDB，Esc 跳过") + "\n\n" + listView(lines, m.cursor, m.listH())
	case scJobs:
		return m.jobsView()
	case scSettings:
		return listView(m.settingLines(), m.setIdx, m.listH())
	case scQR:
		return m.qrWarn + "\n\n" + m.qrASCII
	case scEdit:
		return titleS.Render(m.editField) + "\n\n" + m.editIn.View() + "\n\n" + muteS.Render(m.settingHint(m.editField))
	}
	return ""
}

func (m model) qualityTable() string {
	title := m.detailTitle
	if title == "" {
		title = "视频"
	}
	var b strings.Builder
	b.WriteString(logI(fmt.Sprintf("正在获取「%s」的视频信息  %d 集", title, len(m.pendingBatch))) + "\n")
	if g := strings.TrimSpace(m.cfg.ReleaseGroup); g != "" {
		b.WriteString(logI("发布组  "+g) + "\n")
	}
	b.WriteString("\n")
	type col struct {
		h string
		w int
	}
	cols := []col{
		{"序号", 4},
		{"标题", 18},
		{"视频大小", 10},
		{"分辨率", 12},
		{"编码", 6},
		{"加密", 8},
	}
	rule := func() string {
		var s strings.Builder
		s.WriteString("+")
		for _, c := range cols {
			s.WriteString(strings.Repeat("-", c.w+2) + "+")
		}
		return s.String()
	}
	cell := func(s string, w int) string {
		r := []rune(s)
		if len(r) > w {
			s = string(r[:w])
		}
		return " " + padR(s, w) + " "
	}
	b.WriteString(rule() + "\n|")
	for _, c := range cols {
		b.WriteString(cell(c.h, c.w) + "|")
	}
	b.WriteString("\n" + rule() + "\n")
	for i, q := range m.qList {
		title := q.Title
		if title == "" {
			title = q.Label
		}
		sz := "-"
		if q.Size > 0 {
			sz = human(q.Size)
		}
		res := "-"
		if q.Width > 0 && q.Height > 0 {
			res = fmt.Sprintf("%dx%d", q.Width, q.Height)
		} else if q.Height > 0 {
			res = fmt.Sprintf("%dp", q.Height)
		}
		codec := q.Codec
		if codec == "" {
			codec = "-"
		}
		drm := q.DRM
		if drm == "" {
			drm = "-"
		}
		line := "|" + cell(fmt.Sprintf("%d", i+1), 4) + "|" + cell(title, 18) + "|" + cell(sz, 10) + "|" + cell(res, 12) + "|" + cell(codec, 6) + "|" + cell(drm, 8) + "|"
		if i == m.qIdx {
			b.WriteString(selS.Render(line) + "\n")
		} else {
			b.WriteString(line + "\n")
		}
	}
	b.WriteString(rule() + "\n")
	return b.String()
}

func padR(s string, w int) string {
	n := w - len([]rune(s))
	if n <= 0 {
		return s
	}
	return s + strings.Repeat(" ", n)
}

func (m model) settingLines() []string {
	fields := m.settingFields()
	lines := make([]string, len(fields))
	for i, f := range fields {
		val := ""
		switch f {
		case "隧道":
			if m.tunnelOK {
				val = "已连接 · 优酷/腾讯走本机 IP"
			} else if m.tunnelErr != "" {
				val = "断开  " + m.tunnelErr
			} else {
				val = "未连接"
			}
		case "网关":
			val = m.cfg.Host
		case "Key":
			val = m.cfg.Key
			if len(val) > 12 {
				val = val[:12] + "…"
			}
		case "下载目录":
			val = m.cfg.OutDir
		case "发布组":
			if m.cfg.ReleaseGroup == "" {
				val = "未设"
			} else {
				val = m.cfg.ReleaseGroup
			}
		case "TMDB Key":
			if m.cfg.TMDBKey != "" {
				val = "已配置"
			} else {
				val = "未配置"
			}
		case "优酷 Cookie":
			val = "粘贴浏览器 Cookie（含 P_sck）"
		case "Yk-Sign":
			if m.cfg.YoukuSign != "" {
				val = "已登录"
			} else {
				val = "未登录"
			}
		case "腾讯 Cookie":
			if m.cfg.TencentCookie != "" {
				val = "已保存"
			} else {
				val = "空 · 回车粘贴"
			}
		case "红果合并":
			val = onOff(m.cfg.HongguoMerge)
		case "红果 NFO":
			val = onOff(m.cfg.HongguoNFO)
		case "红果封装":
			val = m.cfg.HongguoFmt
		case "ffmpeg":
			val = m.cfg.FFmpeg
		}
		pad := f
		if n := 10 - len([]rune(f)); n > 0 {
			pad += strings.Repeat(" ", n)
		}
		lines[i] = pad + "  " + muteS.Render(val)
	}
	return lines
}

func onOff(v bool) string {
	if v {
		return "开"
	}
	return "关"
}

func (m model) listH() int {
	h := m.h - 6
	if h < 8 {
		return 12
	}
	return h
}

func clip(s string, n int) string {
	r := []rune(s)
	if n < 1 || len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func (m model) jobsView() string {
	if len(m.jobs) == 0 {
		return logI("没有任务")
	}
	var run, wait, done, fail []jobView
	for _, j := range m.jobs {
		switch j.Status {
		case "排队":
			wait = append(wait, j)
		case "完成":
			done = append(done, j)
		case "失败":
			fail = append(fail, j)
		default:
			run = append(run, j)
		}
	}
	var b strings.Builder
	b.WriteString(logI(fmt.Sprintf("进行 %d  排队 %d  完成 %d  失败 %d", len(run), len(wait), len(done), len(fail))) + "\n\n")
	for _, j := range run {
		b.WriteString(logI(j.Status+"  "+clip(j.Title, 48)) + "\n")
		if j.Status == "下载" {
			b.WriteString("Vid  " + progressBar(j.Pct, 28) + "  " + j.Log + "\n")
		} else if j.Log != "" {
			b.WriteString(muteS.Render("     "+clip(j.Log, 70)) + "\n")
		}
		b.WriteString("\n")
	}
	if n := len(fail); n > 0 {
		show := fail
		if n > 6 {
			show = fail[n-6:]
		}
		for _, j := range show {
			b.WriteString(logE(clip(j.Title, 40)+"  "+clip(j.Err, 50)) + "\n")
		}
	}
	if n := len(done); n > 0 {
		b.WriteString("\n" + logI(fmt.Sprintf("已完成 %d", n)) + "\n")
	}
	return b.String()
}

func (m model) epGridView() string {
	n := len(m.eps)
	if n == 0 {
		return logW("没有剧集")
	}
	cols := m.epCols()
	head := logI(fmt.Sprintf("%s  %d集  已选 %d", clip(m.detailTitle, 36), n, len(m.epSel)))
	avail := m.h - 9
	if avail < 6 {
		avail = 6
	}
	rows := (n + cols - 1) / cols
	startRow := 0
	curRow := 0
	if cols > 0 {
		curRow = m.cursor / cols
	}
	if rows > avail {
		startRow = curRow - avail/2
		if startRow < 0 {
			startRow = 0
		}
		if startRow+avail > rows {
			startRow = rows - avail
		}
	}
	endRow := startRow + avail
	if endRow > rows {
		endRow = rows
	}
	var b strings.Builder
	b.WriteString(head + "\n\n")
	for r := startRow; r < endRow; r++ {
		for c := 0; c < cols; c++ {
			i := r*cols + c
			if i >= n {
				break
			}
			num := m.eps[i].N
			if num == 0 {
				num = i + 1
			}
			cell := fmt.Sprintf("%4d", num)
			_, picked := m.epSel[i]
			switch {
			case i == m.cursor && picked:
				b.WriteString(selS.Render(cell))
			case i == m.cursor:
				b.WriteString(selS.Render(cell))
			case picked:
				b.WriteString(okS.Render(cell))
			default:
				b.WriteString(rowS.Render(cell))
			}
			b.WriteString(" ")
		}
		b.WriteString("\n")
	}
	if m.cursor >= 0 && m.cursor < n {
		ep := m.eps[m.cursor]
		b.WriteString("\n" + muteS.Render(fmt.Sprintf("E%02d  %s", ep.N, clip(ep.Title, 72))))
	}
	return b.String()
}

func listView(items []string, cursor, height int) string {
	if height < 3 {
		height = 8
	}
	cur := cursor
	if len(items) > height {
		start := cursor - height/2
		if start < 0 {
			start = 0
		}
		if start+height > len(items) {
			start = len(items) - height
		}
		cur = cursor - start
		items = items[start : start+height]
	}
	var b strings.Builder
	for i, it := range items {
		if i == cur {
			b.WriteString(selS.Render(" > "+clip(it, 72)+" ") + "\n")
		} else {
			b.WriteString(rowS.Render("   "+clip(it, 72)) + "\n")
		}
	}
	return b.String()
}

func progressBar(p float64, width int) string {
	if width < 8 {
		width = 8
	}
	if p < 0 {
		p = 0
	}
	if p > 1 {
		p = 1
	}
	fill := int(p * float64(width))
	bar := strings.Repeat("=", fill) + strings.Repeat("-", width-fill)
	return barS.Render(bar)
}
