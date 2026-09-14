package main

import (
	"encoding/json"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestVueKeyPreservesShiftedShortcuts(t *testing.T) {
	k := vueKey(vueBridgeRequest{Name: "a", Shift: true})
	if k.Type != tea.KeyRunes || string(k.Runes) != "A" {
		t.Fatalf("shifted key = %#v, want rune A", k)
	}
	if got := vueKey(vueBridgeRequest{Name: "return"}); got.Type != tea.KeyEnter {
		t.Fatalf("return mapped to %v, want enter", got.Type)
	}
	if got := vueKey(vueBridgeRequest{Name: "escape"}); got.Type != tea.KeyEsc {
		t.Fatalf("escape mapped to %v, want esc", got.Type)
	}
	if got := vueKey(vueBridgeRequest{Name: "ArrowDown"}); got.Type != tea.KeyDown {
		t.Fatalf("ArrowDown mapped to %v, want down", got.Type)
	}
}

func TestVueSnapshotUsesQualityCursorAndStableJobJSON(t *testing.T) {
	m := newModel(fileConfig{Host: "http://127.0.0.1:8080"})
	m.sc = scQuality
	m.cursor = 0
	m.qIdx = 2
	m.jobs = []jobView{{ID: 7, Title: "Demo E01", Status: "排队", Pct: 0.25}}
	s := vueBridgeSnapshotFor(m)
	if s.Cursor != 2 {
		t.Fatalf("quality cursor = %d, want 2", s.Cursor)
	}
	b, err := json.Marshal(s.Jobs)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `[{"id":7,"title":"Demo E01","status":"排队","pct":0.25,"log":"","err":""}]` {
		t.Fatalf("jobs JSON = %s", b)
	}
}
