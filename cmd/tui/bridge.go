package main

// The Vue TermUI client uses the existing Go TUI as a local runtime adapter.
// Keeping the state machine here means the Vue renderer can replace Bubble
// Tea's screen without duplicating the download, tunnel, and provider code.

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type vueBridgeRequest struct {
	Type  string `json:"type"`
	Name  string `json:"name,omitempty"`
	Field string `json:"field,omitempty"`
	Value string `json:"value,omitempty"`
	Ctrl  bool   `json:"ctrl,omitempty"`
	Alt   bool   `json:"alt,omitempty"`
	Shift bool   `json:"shift,omitempty"`
}

type vueBridgeRow struct {
	Title string `json:"title"`
	ID    string `json:"id"`
	Sub   string `json:"sub"`
}

type vueBridgeEpisode struct {
	Title    string `json:"title"`
	VID      string `json:"vid"`
	Number   int    `json:"number"`
	Selected bool   `json:"selected"`
}

type vueBridgeQuality struct {
	Label  string `json:"label"`
	Title  string `json:"title"`
	Size   int64  `json:"size"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Codec  string `json:"codec"`
	DRM    string `json:"drm"`
}

type vueBridgeTMDBHit struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Year     int    `json:"year"`
	Overview string `json:"overview,omitempty"`
}

type vueBridgeSetting struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type vueBridgeSnapshot struct {
	Scene         string             `json:"scene"`
	Host          string             `json:"host"`
	Status        string             `json:"status"`
	TunnelOK      bool               `json:"tunnelOk"`
	TunnelError   string             `json:"tunnelError,omitempty"`
	Cursor        int                `json:"cursor"`
	ProviderIndex int                `json:"providerIndex"`
	QualityIndex  int                `json:"qualityIndex"`
	Providers     []string           `json:"providers,omitempty"`
	HomeItems     []string           `json:"homeItems,omitempty"`
	Rows          []vueBridgeRow     `json:"rows,omitempty"`
	Episodes      []vueBridgeEpisode `json:"episodes,omitempty"`
	Qualities     []vueBridgeQuality `json:"qualities,omitempty"`
	TMDBHits      []vueBridgeTMDBHit `json:"tmdbHits,omitempty"`
	Jobs          []jobView          `json:"jobs,omitempty"`
	Settings      []vueBridgeSetting `json:"settings,omitempty"`
	DetailTitle   string             `json:"detailTitle,omitempty"`
	PendingCount  int                `json:"pendingCount,omitempty"`
	Query         string             `json:"query,omitempty"`
	HostInput     string             `json:"hostInput,omitempty"`
	HostFocused   bool               `json:"hostFocused"`
	KeyFocused    bool               `json:"keyFocused"`
	KeyConfigured bool               `json:"keyConfigured"`
	EditField     string             `json:"editField,omitempty"`
	EditValue     string             `json:"editValue,omitempty"`
	QRASCII       string             `json:"qrAscii,omitempty"`
	Footer        string             `json:"footer,omitempty"`
}

func runVueBridge() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	in := make(chan vueBridgeRequest, 32)
	msgs := make(chan tea.Msg, 256)
	go func() {
		s := bufio.NewScanner(os.Stdin)
		for s.Scan() {
			var req vueBridgeRequest
			if json.Unmarshal(s.Bytes(), &req) == nil {
				in <- req
			}
		}
		close(in)
	}()

	var dispatch func(tea.Cmd)
	dispatch = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		go func() {
			msg := cmd()
			if batch, ok := msg.(tea.BatchMsg); ok {
				for _, child := range batch {
					dispatch(child)
				}
				return
			}
			if msg != nil {
				msgs <- msg
			}
		}()
	}

	m := newModel(loadConfig())
	emit := func() {
		_ = enc.Encode(vueBridgeSnapshotFor(m))
	}
	emit()
	dispatch(m.Init())

	for {
		select {
		case req, ok := <-in:
			if !ok {
				return
			}
			switch req.Type {
			case "key":
				m2, cmd := m.Update(vueKey(req))
				m = m2.(model)
				dispatch(cmd)
				emit()
			case "set":
				m.setVueBridgeValue(req.Field, req.Value)
				emit()
			case "quit":
				return
			}
		case msg := <-msgs:
			if _, ok := msg.(tea.QuitMsg); ok {
				return
			}
			m2, cmd := m.Update(msg)
			m = m2.(model)
			dispatch(cmd)
			emit()
		}
	}
}

func vueKey(req vueBridgeRequest) tea.KeyMsg {
	name := strings.ToLower(strings.TrimSpace(req.Name))
	k := tea.KeyMsg{Alt: req.Alt}
	switch name {
	case "enter", "return":
		k.Type = tea.KeyEnter
	case "esc", "escape":
		k.Type = tea.KeyEsc
	case "tab":
		k.Type = tea.KeyTab
	case "backspace":
		k.Type = tea.KeyBackspace
	case "delete":
		k.Type = tea.KeyDelete
	case "up", "arrowup":
		k.Type = tea.KeyUp
	case "down", "arrowdown":
		k.Type = tea.KeyDown
	case "left", "arrowleft":
		k.Type = tea.KeyLeft
	case "right", "arrowright":
		k.Type = tea.KeyRight
	case "space", " ":
		k.Type = tea.KeySpace
	default:
		if req.Ctrl && len(name) == 1 {
			switch name[0] {
			case 'c':
				k.Type = tea.KeyCtrlC
				return k
			case 'd':
				k.Type = tea.KeyCtrlD
				return k
			}
		}
		k.Type = tea.KeyRunes
		runes := []rune(req.Name)
		// OpenTUI reports shifted letters as name="a", shift=true. Bubble
		// Tea's state machine distinguishes "a" from "A" (the latter is
		// used for the select-all shortcut), so preserve that modifier.
		if req.Shift && len(runes) == 1 && runes[0] >= 'a' && runes[0] <= 'z' {
			runes[0] = runes[0] - ('a' - 'A')
		}
		k.Runes = runes
	}
	return k
}

func (m *model) setVueBridgeValue(field, value string) {
	switch field {
	case "query":
		m.qIn.SetValue(value)
	case "host":
		m.hostIn.SetValue(value)
		m.cfg.Host = strings.TrimRight(strings.TrimSpace(value), "/")
	case "key":
		m.keyIn.SetValue(value)
	case "edit":
		m.editIn.SetValue(value)
	}
}

func vueBridgeSnapshotFor(m model) vueBridgeSnapshot {
	cursor := m.cursor
	if m.sc == scQuality {
		// Quality selection uses qIdx in the Bubble Tea model. Expose that
		// same index to Vue so the highlighted row and keyboard selection
		// cannot drift apart.
		cursor = m.qIdx
	} else if m.sc == scSettings {
		cursor = m.setIdx
	}
	s := vueBridgeSnapshot{
		Scene:         sceneName(m.sc),
		Host:          m.cfg.Host,
		Status:        m.status,
		TunnelOK:      m.tunnelOK,
		TunnelError:   m.tunnelErr,
		Cursor:        cursor,
		ProviderIndex: m.provIdx,
		QualityIndex:  m.qIdx,
		Providers:     m.providers(),
		HomeItems:     m.homeItems(),
		DetailTitle:   m.detailTitle,
		PendingCount:  len(m.pendingBatch),
		Query:         m.qIn.Value(),
		HostInput:     m.hostIn.Value(),
		HostFocused:   m.hostIn.Focused(),
		KeyFocused:    m.keyIn.Focused(),
		KeyConfigured: strings.TrimSpace(m.cfg.Key) != "",
		EditField:     m.editField,
		EditValue:     m.editIn.Value(),
		QRASCII:       m.qrASCII,
		Footer:        m.footer(),
	}
	for _, r := range m.rows {
		s.Rows = append(s.Rows, vueBridgeRow{Title: r.Title, ID: r.ID, Sub: r.Sub})
	}
	for i, ep := range m.eps {
		_, selected := m.epSel[i]
		s.Episodes = append(s.Episodes, vueBridgeEpisode{Title: ep.Title, VID: ep.VID, Number: ep.N, Selected: selected})
	}
	for _, q := range m.qList {
		s.Qualities = append(s.Qualities, vueBridgeQuality{Label: q.Label, Title: q.Title, Size: q.Size, Width: q.Width, Height: q.Height, Codec: q.Codec, DRM: q.DRM})
	}
	for _, hit := range m.tmdbHits {
		name := hit.Name
		if name == "" {
			name = hit.Title
		}
		s.TMDBHits = append(s.TMDBHits, vueBridgeTMDBHit{ID: hit.ID, Name: name, Title: hit.Title, Year: hit.year(), Overview: hit.Overview})
	}
	s.Jobs = append(s.Jobs, m.jobs...)
	for _, f := range m.settingFields() {
		value := ""
		for _, line := range m.settingLines() {
			if strings.HasPrefix(line, f) {
				value = strings.TrimSpace(strings.TrimPrefix(line, f))
				break
			}
		}
		s.Settings = append(s.Settings, vueBridgeSetting{Label: f, Value: value})
	}
	return s
}

func sceneName(sc screen) string {
	return []string{"setup", "home", "search", "results", "detail", "quality", "tmdb", "jobs", "settings", "qr", "edit"}[int(sc)]
}
