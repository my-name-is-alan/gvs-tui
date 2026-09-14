package main

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestQualitySelectionAppliesToWholeBatch(t *testing.T) {
	m := newModel(fileConfig{})
	m.pendingBatch = []dlTask{{Provider: "tencent", VID: "a", Episode: 1}, {Provider: "tencent", VID: "b", Episode: 2}}
	m.qList = []qChoice{{ID: "fhd", Label: "1080p", Height: 1080, Codec: "H265"}}
	m.detailProv = "tencent"
	m.detailTitle = "Demo"
	m.cfg.TMDBKey = "test-key"
	m.sc = scQuality
	m2, _ := m.updateQuality(keyEnter())
	got := m2.(model)
	if got.sc != scQuality || len(got.pendingBatch) != 2 {
		t.Fatalf("whole batch not retained: scene=%v pending=%d", got.sc, len(got.pendingBatch))
	}
	for i, task := range got.pendingBatch {
		if task.Quality != "fhd" || task.Height != 1080 || task.Codec != "H265" {
			t.Fatalf("task %d quality not applied: %+v", i, task)
		}
	}
}

func TestQualityProbeFailureFallsBackToProviderDefault(t *testing.T) {
	m := newModel(fileConfig{})
	m.pendingBatch = []dlTask{{Provider: "tencent", VID: "a", Episode: 1}}
	m.sc = scQuality
	m2, _ := m.Update(qualityMsg{err: errQualityUnavailable{}})
	got := m2.(model)
	if got.sc != scJobs || len(got.jobs) != 1 {
		t.Fatalf("default fallback did not queue: scene=%v jobs=%d status=%q", got.sc, len(got.jobs), got.status)
	}
}

// Small local key/error values keep these tests independent of network and
// provider implementations.
func keyEnter() tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyEnter} }

type errQualityUnavailable struct{}

func (errQualityUnavailable) Error() string { return "quality unavailable" }
