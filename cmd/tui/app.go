package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

type screen int

const (
	scSetup screen = iota
	scHome
	scSearch
	scResults
	scDetail
	scQuality
	scTMDB
	scJobs
	scSettings
	scQR
	scEdit
)

type row struct {
	Title, ID, Sub string
}

type epRow struct {
	Title, VID string
	N          int
}

type jobView struct {
	ID     int     `json:"id"`
	Title  string  `json:"title"`
	Status string  `json:"status"`
	Pct    float64 `json:"pct"`
	Log    string  `json:"log"`
	Err    string  `json:"err"`
}

type model struct {
	cfg    fileConfig
	key    *keyInfo
	cli    *gwClient
	hub    *jobHub
	sc     screen
	status string
	w, h   int

	hostIn, keyIn, qIn, editIn textinput.Model
	cursor                     int
	provIdx                    int
	rows                       []row
	eps                        []epRow
	detailTitle                string
	detailID                   string
	detailProv                 string
	tmdbHits                   []tmdbHit
	jobs                       []jobView
	setIdx                     int
	qrASCII, qrTicket          string
	qrWarn                     string
	pending                    *dlTask
	pendingBatch               []dlTask
	epSel                      map[int]struct{}
	qList                      []qChoice
	qIdx                       int
	tunnelOn                   bool
	tunnelOK                   bool
	tunnelErr                  string
	editField                  string
}

func newModel(cfg fileConfig) model {
	hi := textinput.New()
	hi.Placeholder = "http://127.0.0.1:8080"
	hi.SetValue(cfg.Host)
	hi.Width = 48
	ki := textinput.New()
	ki.Placeholder = "sk_live_...."
	ki.SetValue(cfg.Key)
	ki.EchoMode = textinput.EchoPassword
	ki.Width = 48
	qi := textinput.New()
	qi.Placeholder = "搜索标题 / 粘贴链接"
	qi.Width = 56
	ei := textinput.New()
	ei.Width = 56
	m := model{cfg: cfg, hub: newHub(), hostIn: hi, keyIn: ki, qIn: qi, editIn: ei}
	if strings.TrimSpace(cfg.Key) == "" {
		m.sc = scSetup
		hi.Focus()
	} else {
		m.cli = newClient(cfg.Host, cfg.Key)
		m.sc = scHome
	}
	return m
}

func (m model) Init() tea.Cmd {
	if m.sc == scSetup {
		return textinput.Blink
	}
	return tea.Batch(m.refreshKey(), m.hub.wait())
}

type keyMsg struct {
	k   *keyInfo
	err error
}
type listMsg struct {
	rows []row
	err  error
}
type detailMsg struct {
	title string
	eps   []epRow
	err   error
}
type tmdbMsg struct {
	hits []tmdbHit
	err  error
}
type qrMsg struct {
	ticket, url, ascii string
	err                error
}
type qrPollMsg struct {
	sign    string
	pending bool
	err     error
}
type qrTick struct{}
type cookieMsg struct {
	sign string
	err  error
}

func (m model) refreshKey() tea.Cmd {
	cli := m.cli
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		k, err := cli.keyInfo(ctx)
		return keyMsg{k: k, err: err}
	}
}

func (m model) providers() []string {
	all := []string{"youku", "tencent", "hongguo", "douyin"}
	if m.key == nil {
		return all
	}
	var out []string
	for _, p := range all {
		if m.cli.allows(m.key.Scope, m.key.All, p) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return all
	}
	return out
}

func (m model) has(p string) bool {
	if m.key == nil || m.cli == nil {
		return true
	}
	return m.cli.allows(m.key.Scope, m.key.All, p)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		return m, nil
	case keyMsg:
		if msg.err != nil {
			m.status = "Key 无效：" + msg.err.Error()
			m.sc = scSetup
			m.keyIn.Focus()
			return m, textinput.Blink
		}
		m.key = msg.k
		m.status = fmt.Sprintf("%s  scope=%s  %s", msg.k.Name, scopeText(msg.k), expiryText(msg.k))
		cmds := []tea.Cmd{m.hub.wait()}
		if !m.tunnelOn && (m.has("youku") || m.has("tencent")) {
			m.tunnelOn = true
			host, key, hub := m.cfg.Host, m.cfg.Key, m.hub
			go runTunnel(host, key, func(s tunnelMsg) { hub.send(s) })
		}
		return m, tea.Batch(cmds...)
	case tunnelMsg:
		m.tunnelOK = msg.OK
		m.tunnelErr = msg.Err
		if msg.OK {
			m.status = "隧道已连接：优酷/腾讯走本机 IP"
		} else if msg.Err != "" {
			m.status = "隧道断开 " + msg.Err
		}
		return m, m.hub.wait()
	case cookieMsg:
		if msg.err != nil {
			m.status = "Cookie 导入失败：" + msg.err.Error()
			return m, m.hub.wait()
		}
		m.cfg.YoukuSign = msg.sign
		_ = saveConfig(m.cfg)
		m.status = "优酷 Cookie 已导入"
		m.sc = scSettings
		return m, m.hub.wait()

	case listMsg:
		m.rows = msg.rows
		m.cursor = 0
		if msg.err != nil {
			m.status = msg.err.Error()
		} else {
			m.status = fmt.Sprintf("%d 条", len(m.rows))
			m.sc = scResults
		}
		return m, m.hub.wait()
	case detailMsg:
		if msg.err != nil {
			m.status = msg.err.Error()
			return m, m.hub.wait()
		}
		m.detailTitle = msg.title
		m.eps = msg.eps
		m.cursor = 0
		m.epSel = map[int]struct{}{}
		m.sc = scDetail
		return m, m.hub.wait()
	case qualityMsg:
		if msg.err != nil {
			// A provider may expose a playable default stream without exposing a
			// quality catalogue (or the catalogue can be temporarily unavailable).
			// Keep Enter on an episode/whole collection useful in that case: queue
			// the pending tasks with an empty quality so each download pipeline
			// selects its provider default. Previously this left the user on the
			// detail screen and often produced an empty/NaN job row in the Vue UI.
			if len(m.pendingBatch) > 0 {
				m.status = "画质不可用，使用默认画质：" + msg.err.Error()
				return m.afterQuality()
			}
			m.status = "画质: " + msg.err.Error()
			m.sc = scDetail
			return m, m.hub.wait()
		}
		if len(msg.list) == 0 {
			if len(m.pendingBatch) > 0 {
				m.status = "没有画质列表，使用默认画质"
				return m.afterQuality()
			}
			m.status = "没有画质"
			m.sc = scDetail
			return m, m.hub.wait()
		}
		m.qList = msg.list
		m.qIdx = 0
		m.sc = scQuality
		m.status = fmt.Sprintf("%d 档 · %d 集", len(msg.list), len(m.pendingBatch))
		return m, m.hub.wait()

	case tmdbMsg:
		if msg.err != nil {
			m.status = "TMDB: " + msg.err.Error()
			return m.enqueueAll(m.pendingBatch)
		}
		m.tmdbHits = msg.hits
		m.cursor = 0
		if len(msg.hits) == 0 {
			return m.enqueueAll(m.pendingBatch)
		}
		m.sc = scTMDB
		return m, m.hub.wait()
	case qrMsg:
		if msg.err != nil {
			m.status = msg.err.Error()
			m.sc = scSettings
			return m, m.hub.wait()
		}
		m.qrTicket, m.qrASCII = msg.ticket, msg.ascii
		m.sc = scQR
		return m, tea.Batch(m.hub.wait(), tea.Tick(pollDelay(), func(time.Time) tea.Msg { return qrTick{} }))
	case qrTick:
		if m.sc != scQR {
			return m, m.hub.wait()
		}
		cli, ticket := m.cli, m.qrTicket
		return m, tea.Batch(m.hub.wait(), func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			sign, pending, err := pollYoukuQR(ctx, cli, ticket)
			_ = pending
			return qrPollMsg{sign: sign, pending: pending, err: err}
		})
	case qrPollMsg:
		if msg.sign != "" {
			m.cfg.YoukuSign = msg.sign
			_ = saveConfig(m.cfg)
			m.status = "已保存 Yk-Sign"
			m.sc = scSettings
			return m, m.hub.wait()
		}
		if m.sc != scQR {
			return m, m.hub.wait()
		}
		if msg.err != nil {
			m.status = msg.err.Error()
		}
		return m, tea.Batch(m.hub.wait(), tea.Tick(pollDelay(), func(time.Time) tea.Msg { return qrTick{} }))
	case jobEvt:
		m.applyJob(msg)
		return m, m.hub.wait()
	case tea.KeyMsg:
		return m.keyUpdate(msg)
	}
	return m, nil
}

func (m *model) applyJob(e jobEvt) {
	for i := range m.jobs {
		if m.jobs[i].ID == e.ID {
			m.jobs[i].Status = e.Status
			m.jobs[i].Pct = e.Pct
			if e.Log != "" {
				m.jobs[i].Log = e.Log
			}
			m.jobs[i].Err = e.Err
			return
		}
	}
}

func (m model) keyUpdate(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	switch m.sc {
	case scSetup:
		return m.updateSetup(msg)
	case scHome:
		return m.updateHome(msg)
	case scSearch:
		return m.updateSearch(msg)
	case scResults:
		return m.updateResults(msg)
	case scDetail:
		return m.updateDetail(msg)
	case scQuality:
		return m.updateQuality(msg)
	case scTMDB:
		return m.updateTMDB(msg)
	case scJobs:
		return m.updateJobs(msg)
	case scSettings:
		return m.updateSettings(msg)
	case scQR:
		if msg.String() == "esc" {
			m.sc = scSettings
		}
		return m, nil
	case scEdit:
		return m.updateEdit(msg)
	}
	return m, nil
}

func (m model) updateSetup(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "tab":
		if m.hostIn.Focused() {
			m.hostIn.Blur()
			m.keyIn.Focus()
		} else {
			m.keyIn.Blur()
			m.hostIn.Focus()
		}
		return m, textinput.Blink
	case "enter":
		m.cfg.Host = strings.TrimRight(strings.TrimSpace(m.hostIn.Value()), "/")
		m.cfg.Key = strings.TrimSpace(m.keyIn.Value())
		if m.cfg.Key == "" {
			m.status = "请填写 API Key"
			return m, nil
		}
		_ = saveConfig(m.cfg)
		m.cli = newClient(m.cfg.Host, m.cfg.Key)
		m.sc = scHome
		return m, tea.Batch(m.refreshKey(), m.hub.wait())
	}
	var cmd tea.Cmd
	if m.hostIn.Focused() {
		m.hostIn, cmd = m.hostIn.Update(msg)
	} else {
		m.keyIn, cmd = m.keyIn.Update(msg)
	}
	return m, cmd
}

func (m model) homeItems() []string {
	items := []string{"搜索"}
	if m.has("hongguo") || m.has("youku") || m.has("tencent") {
		items = append(items, "榜单")
	}
	items = append(items, "任务", "设置")
	return items
}

func (m model) updateHome(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	items := m.homeItems()
	switch msg.String() {
	case "j", "down":
		m.cursor = (m.cursor + 1) % len(items)
	case "k", "up":
		m.cursor = (m.cursor - 1 + len(items)) % len(items)
	case "enter":
		switch items[m.cursor] {
		case "搜索":
			m.sc = scSearch
			m.qIn.Focus()
			return m, textinput.Blink
		case "榜单":
			return m, tea.Batch(m.rankCmd(), m.hub.wait())
		case "任务":
			m.sc = scJobs
		case "设置":
			m.sc = scSettings
			m.setIdx = 0
		}
	case "q":
		return m, tea.Quit
	}
	return m, nil
}

func (m model) updateSearch(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	ps := m.providers()
	switch msg.String() {
	case "esc":
		m.sc = scHome
		m.qIn.Blur()
		return m, nil
	case "left", "h":
		if len(ps) > 0 {
			m.provIdx = (m.provIdx - 1 + len(ps)) % len(ps)
		}
		return m, nil
	case "right", "l":
		if len(ps) > 0 {
			m.provIdx = (m.provIdx + 1) % len(ps)
		}
		return m, nil
	case "enter":
		q := strings.TrimSpace(m.qIn.Value())
		if q == "" {
			return m, nil
		}
		p := "hongguo"
		if m.provIdx < len(ps) {
			p = ps[m.provIdx]
		}
		return m, tea.Batch(m.searchCmd(p, q), m.hub.wait())
	}
	var cmd tea.Cmd
	m.qIn, cmd = m.qIn.Update(msg)
	return m, cmd
}

func (m model) updateResults(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.rows) == 0 {
		if msg.String() == "esc" {
			m.sc = scSearch
		}
		return m, nil
	}
	switch msg.String() {
	case "esc":
		m.sc = scSearch
		return m, nil
	case "j", "down":
		m.cursor = (m.cursor + 1) % len(m.rows)
	case "k", "up":
		m.cursor = (m.cursor - 1 + len(m.rows)) % len(m.rows)
	case "enter":
		r := m.rows[m.cursor]
		m.detailProv = r.Sub
		m.detailID = r.ID
		return m, tea.Batch(m.detailCmd(r.Sub, r.ID), m.hub.wait())
	}
	return m, nil
}

func (m model) updateDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	n := len(m.eps)
	if n == 0 {
		if msg.String() == "esc" {
			m.sc = scResults
		}
		return m, nil
	}
	cols := m.epCols()
	switch msg.String() {
	case "esc":
		m.sc = scResults
		return m, nil
	case "left", "h":
		m.cursor = (m.cursor - 1 + n) % n
	case "right", "l":
		m.cursor = (m.cursor + 1) % n
	case "j", "down":
		if m.cursor+cols < n {
			m.cursor += cols
		} else {
			m.cursor = m.cursor % cols
		}
	case "k", "up":
		if m.cursor-cols >= 0 {
			m.cursor -= cols
		} else {
			col := m.cursor % cols
			last := col + cols*((n-1-col)/cols)
			m.cursor = last
		}
	case " ":
		if m.epSel == nil {
			m.epSel = map[int]struct{}{}
		}
		if _, ok := m.epSel[m.cursor]; ok {
			delete(m.epSel, m.cursor)
		} else {
			m.epSel[m.cursor] = struct{}{}
		}
	case "a":
		m.epSel = map[int]struct{}{}
		for i := 0; i < n; i++ {
			m.epSel[i] = struct{}{}
		}
		m.status = fmt.Sprintf("已选 %d 集", n)
	case "c":
		m.epSel = map[int]struct{}{}
		m.status = "已清空选择"
	case "enter":
		tasks := m.selectedTasks()
		if len(tasks) == 0 {
			tasks = []dlTask{m.taskFromEp(m.cursor)}
		}
		return m.queueEpisodes(tasks)
	case "d":
		tasks := m.selectedTasks()
		if len(tasks) == 0 {
			tasks = []dlTask{m.taskFromEp(m.cursor)}
		}
		return m.queueEpisodes(tasks)
	case "A", "f":
		return m.queueEpisodes(m.allTasks())
	}
	return m, nil
}

func (m model) updateQuality(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	n := len(m.qList)
	switch msg.String() {
	case "esc":
		m.sc = scDetail
		return m, nil
	case "j", "down":
		if n > 0 {
			m.qIdx = (m.qIdx + 1) % n
		}
	case "k", "up":
		if n > 0 {
			m.qIdx = (m.qIdx - 1 + n) % n
		}
	case "enter":
		if n == 0 {
			return m, nil
		}
		q := m.qList[m.qIdx]
		for i := range m.pendingBatch {
			m.pendingBatch[i].Quality = q.ID
			m.pendingBatch[i].Group = m.cfg.ReleaseGroup
			if q.Height > 0 {
				m.pendingBatch[i].Height = q.Height
			}
			if q.Codec != "" {
				m.pendingBatch[i].Codec = q.Codec
			}
		}

		m.status = "画质 " + q.Label
		return m.afterQuality()
	}
	return m, nil
}

func (m model) updateTMDB(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return m.enqueueAll(m.pendingBatch)
	case "j", "down":
		if len(m.tmdbHits) > 0 {
			m.cursor = (m.cursor + 1) % len(m.tmdbHits)
		}
	case "k", "up":
		if len(m.tmdbHits) > 0 {
			m.cursor = (m.cursor - 1 + len(m.tmdbHits)) % len(m.tmdbHits)
		}
	case "enter":
		if m.cursor < len(m.tmdbHits) {
			h := m.tmdbHits[m.cursor]
			for i := range m.pendingBatch {
				m.pendingBatch[i].TMDBID = h.ID
				m.pendingBatch[i].Year = h.year()
				m.pendingBatch[i].NameDots = h.englishDots()
				m.pendingBatch[i].Plot = h.Overview
				if h.Name != "" {
					m.pendingBatch[i].Series = h.Name
				}
			}
		}
		return m.enqueueAll(m.pendingBatch)
	}
	return m, nil
}

func (m model) updateJobs(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "esc" {
		m.sc = scHome
	}
	return m, nil
}

func (m model) updateSettings(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	fields := m.settingFields()
	switch msg.String() {
	case "esc":
		m.sc = scHome
		_ = saveConfig(m.cfg)
		return m, nil
	case "j", "down":
		if len(fields) > 0 {
			m.setIdx = (m.setIdx + 1) % len(fields)
		}
	case "k", "up":
		if len(fields) > 0 {
			m.setIdx = (m.setIdx - 1 + len(fields)) % len(fields)
		}
	case "enter", " ":
		if len(fields) == 0 {
			return m, nil
		}
		return m.openSetting(fields[m.setIdx])
	}
	return m, nil
}

func (m model) openSetting(f string) (tea.Model, tea.Cmd) {
	switch f {
	case "隧道":
		if m.tunnelOK {
			m.status = "隧道已连接"
		} else if m.tunnelErr != "" {
			m.status = m.tunnelErr
		} else {
			m.status = "未连接"
		}
		return m, nil
	case "优酷扫码":
		if !hostIsLocal(m.cfg.Host) {
			m.qrWarn = "扫码从本机 IP 出网（隧道）。"
		} else {
			m.qrWarn = "本机网关，扫码从家庭 IP 出去。"
		}
		cli := m.cli
		return m, tea.Batch(m.hub.wait(), func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			ticket, u, ascii, err := startYoukuQR(ctx, cli)
			return qrMsg{ticket: ticket, url: u, ascii: ascii, err: err}
		})
	case "Yk-Sign":
		m.status = "登录态由扫码或导入 Cookie 写入，不能手改。"
		return m, nil
	case "红果合并":
		m.cfg.HongguoMerge = !m.cfg.HongguoMerge
		_ = saveConfig(m.cfg)
		return m, nil
	case "红果 NFO":
		m.cfg.HongguoNFO = !m.cfg.HongguoNFO
		_ = saveConfig(m.cfg)
		return m, nil
	case "红果封装":
		if m.cfg.HongguoFmt == "mp4" {
			m.cfg.HongguoFmt = "mkv"
		} else {
			m.cfg.HongguoFmt = "mp4"
		}
		_ = saveConfig(m.cfg)
		return m, nil
	}
	m.editField = f
	m.editIn.SetValue(m.settingValue(f))
	m.editIn.Placeholder = m.settingHint(f)
	m.editIn.EchoMode = textinput.EchoNormal
	if f == "Key" || f == "TMDB Key" {
		m.editIn.EchoMode = textinput.EchoPassword
	}
	m.editIn.Focus()
	m.sc = scEdit
	return m, textinput.Blink
}

func (m model) settingValue(f string) string {
	switch f {
	case "网关":
		return m.cfg.Host
	case "Key":
		return m.cfg.Key
	case "下载目录":
		return m.cfg.OutDir
	case "发布组":
		return m.cfg.ReleaseGroup
	case "TMDB Key":
		return m.cfg.TMDBKey
	case "优酷 Cookie":
		return ""
	case "腾讯 Cookie":
		return m.cfg.TencentCookie
	case "ffmpeg":
		return m.cfg.FFmpeg
	}
	return ""
}

func (m model) settingHint(f string) string {
	switch f {
	case "发布组":
		return "如 ADWeb / 留空则用默认"
	case "优酷 Cookie":
		return "浏览器整段 Cookie，须含 P_sck="
	case "腾讯 Cookie":
		return "从 qq.com 复制登录 Cookie"
	case "下载目录":
		return `D:\Downloads 或 ~/Videos`
	}
	return ""
}

func (m model) updateEdit(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.editIn.Blur()
		m.sc = scSettings
		return m, nil
	case "enter":
		v := strings.TrimSpace(m.editIn.Value())
		m.editIn.Blur()
		return m.commitEdit(v)
	}
	var cmd tea.Cmd
	m.editIn, cmd = m.editIn.Update(msg)
	return m, cmd
}

func (m model) commitEdit(v string) (tea.Model, tea.Cmd) {
	switch m.editField {
	case "网关":
		m.cfg.Host = strings.TrimRight(v, "/")
		m.cli = newClient(m.cfg.Host, m.cfg.Key)
	case "Key":
		m.cfg.Key = v
		m.cli = newClient(m.cfg.Host, m.cfg.Key)
		_ = saveConfig(m.cfg)
		m.sc = scSettings
		return m, tea.Batch(m.refreshKey(), m.hub.wait())
	case "下载目录":
		m.cfg.OutDir = v
	case "发布组":
		m.cfg.ReleaseGroup = v
	case "TMDB Key":
		m.cfg.TMDBKey = v
	case "腾讯 Cookie":
		m.cfg.TencentCookie = v
	case "ffmpeg":
		m.cfg.FFmpeg = v
	case "优酷 Cookie":
		if v == "" {
			m.status = "Cookie 为空"
			m.sc = scSettings
			return m, nil
		}
		cli := m.cli
		ck := v
		m.sc = scSettings
		m.status = "正在导入优酷 Cookie…"
		return m, tea.Batch(m.hub.wait(), func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			sign, err := importYoukuCookie(ctx, cli, ck)
			return cookieMsg{sign: sign, err: err}
		})
	}
	_ = saveConfig(m.cfg)
	m.status = m.editField + " 已保存"
	m.sc = scSettings
	return m, nil
}

func (m model) epCols() int {
	w := m.w
	if w < 48 {
		w = 80
	}
	n := w / 6
	if n < 8 {
		n = 8
	}
	if n > 16 {
		n = 16
	}
	return n
}

func (m model) taskFromEp(i int) dlTask {
	ep := m.eps[i]
	t := dlTask{
		Provider: m.detailProv,
		Title:    ep.Title,
		Series:   m.detailTitle,
		VID:      ep.VID,
		Season:   1,
		Episode:  ep.N,
		Group:    m.cfg.ReleaseGroup,
	}
	if t.Episode == 0 {
		t.Episode = i + 1
	}
	return t
}

func (m model) selectedTasks() []dlTask {
	var out []dlTask
	for i := range m.eps {
		if _, ok := m.epSel[i]; ok {
			out = append(out, m.taskFromEp(i))
		}
	}
	return out
}

func (m model) allTasks() []dlTask {
	out := make([]dlTask, len(m.eps))
	for i := range m.eps {
		out[i] = m.taskFromEp(i)
	}
	return out
}

func (m model) queueEpisodes(tasks []dlTask) (model, tea.Cmd) {
	if len(tasks) == 0 {
		return m, nil
	}
	m.pendingBatch = tasks
	vid := tasks[0].VID
	prov := m.detailProv
	cfg := m.cfg
	cli := m.cli
	m.status = "正在取画质…"
	return m, tea.Batch(m.hub.wait(), func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		list, err := probeQualities(ctx, cli, cfg, prov, vid)
		return qualityMsg{list: list, err: err}
	})
}

func (m model) afterQuality() (model, tea.Cmd) {
	tasks := m.pendingBatch
	if (m.detailProv == "youku" || m.detailProv == "tencent") && strings.TrimSpace(m.cfg.TMDBKey) != "" {
		title := m.detailTitle
		return m, tea.Batch(func() tea.Msg {
			hits, err := tmdbSearch(m.cfg.TMDBKey, m.cfg.TMDBLang, title, true)
			return tmdbMsg{hits: hits, err: err}
		}, m.hub.wait())
	}
	return m.enqueueAll(tasks)
}

func (m model) enqueueAll(tasks []dlTask) (model, tea.Cmd) {
	if len(tasks) == 0 {
		return m, m.hub.wait()
	}
	for i := range tasks {
		t := tasks[i]
		id := nextJobID()
		q := t.Quality
		title := fmt.Sprintf("%s E%02d", t.Series, t.Episode)
		if q != "" {
			title += " " + q
		}
		m.jobs = append(m.jobs, jobView{ID: id, Title: title, Status: "排队"})
		m.hub.enqueue(id, m.cfg, m.cli, t)
	}
	m.pending = nil
	m.pendingBatch = nil
	m.sc = scJobs
	m.status = fmt.Sprintf("已加入 %d 个任务", len(tasks))
	return m, m.hub.wait()
}

func (m model) settingFields() []string {
	var f []string
	f = append(f, "隧道", "网关", "Key", "下载目录")
	if m.has("youku") || m.has("tencent") || m.has("hongguo") {
		f = append(f, "发布组")
	}
	if m.has("youku") || m.has("tencent") {
		f = append(f, "TMDB Key")
	}
	if m.has("youku") {
		f = append(f, "优酷扫码", "优酷 Cookie", "Yk-Sign")
	}
	if m.has("tencent") {
		f = append(f, "腾讯 Cookie")
	}
	if m.has("hongguo") {
		f = append(f, "红果合并", "红果 NFO", "红果封装")
	}
	f = append(f, "ffmpeg")
	return f
}

func (m model) searchCmd(provider, q string) tea.Cmd {
	cli := m.cli
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		var data map[string]any
		if err := cli.invoke(ctx, provider, "search", map[string]any{"q": q, "pageSize": 20}, nil, &data); err != nil {
			return listMsg{err: err}
		}
		return listMsg{rows: parseSearch(provider, data)}
	}
}

func (m model) rankCmd() tea.Cmd {
	ps := m.providers()
	p := "hongguo"
	for _, x := range ps {
		if x == "youku" || x == "tencent" || x == "hongguo" {
			p = x
			break
		}
	}
	cli := m.cli
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		var data map[string]any
		if err := cli.invoke(ctx, p, "browse", map[string]any{"mode": "rank", "pageSize": 20}, nil, &data); err != nil {
			return listMsg{err: err}
		}
		return listMsg{rows: parseSearch(p, data)}
	}
}

func (m model) detailCmd(provider, id string) tea.Cmd {
	cli := m.cli
	return func() tea.Msg {
		id = strings.TrimSpace(id)
		if id == "" || id == "<nil>" || id == "null" {
			return detailMsg{err: fmt.Errorf("这条没有剧 ID，换一条")}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		input := map[string]any{"id": id}
		switch provider {
		case "hongguo":
			input["seriesId"] = id
		case "youku":
			input["showId"] = id
			input["all"] = "1"
		case "tencent":
			input["cid"] = id
		default:
			input["id"] = id
		}
		var data map[string]any
		if err := cli.invoke(ctx, provider, "detail", input, nil, &data); err != nil {
			return detailMsg{err: err}
		}
		title := asString(data["title"])
		return detailMsg{title: title, eps: parseEps(data)}
	}
}

func parseSearch(provider string, data map[string]any) []row {
	var rows []row
	arr, _ := data["list"].([]any)
	if len(arr) == 0 {
		arr, _ = data["items"].([]any)
	}
	seen := map[string]bool{}
	for _, it := range arr {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		title := firstStr(m, "title", "name", "seriesName")
		id := firstStr(m, "seriesId", "showId", "cid", "vid", "id")
		if id == "<nil>" || id == "null" {
			id = ""
		}
		key := id + "|" + title
		if title == "" && id == "" || seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, row{Title: title, ID: id, Sub: provider})
	}
	return rows
}

func parseEps(data map[string]any) []epRow {
	var eps []epRow
	arr, _ := data["episodes"].([]any)
	for i, it := range arr {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		title := firstStr(m, "title", "name")
		vid := firstStr(m, "vid", "id")
		n := i + 1
		if v, ok := m["ep"].(float64); ok {
			n = int(v)
		}
		if v, ok := m["stage"].(string); ok {
			if x, err := strconv.Atoi(v); err == nil {
				n = x
			}
		}
		eps = append(eps, epRow{Title: title, VID: vid, N: n})
	}
	return eps
}

func firstStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := asString(m[k]); s != "" {
			return s
		}
	}
	return ""
}

func scopeText(k *keyInfo) string {
	if k.All || len(k.Scope) == 0 {
		return "全部"
	}
	return strings.Join(k.Scope, ",")
}

func expiryText(k *keyInfo) string {
	if k.Permanent || k.ExpiresAt == nil {
		return "永不到期"
	}
	if k.DaysLeft != nil {
		return fmt.Sprintf("剩 %d 天", *k.DaysLeft)
	}
	return *k.ExpiresAt
}

func (m *model) patchQRSign(sign string) {
	m.cfg.YoukuSign = sign
	_ = saveConfig(m.cfg)
	m.status = "已保存 Yk-Sign"
	m.sc = scSettings
}
