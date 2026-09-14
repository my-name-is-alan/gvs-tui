package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type mediaKind int

const (
	kindShow mediaKind = iota
	kindMovie
	kindShort // hongguo / social
)

type naming struct {
	Kind      mediaKind
	Title     string // display / folder
	NameDots  string // file stem english-ish
	Year      int
	Season    int
	Episode   int
	Height    int
	Codec     string // H265 / H264
	Audio     string
	DV        bool
	Source    string // YK / TX / HG / DY ...
	Group     string
	TMDBID    int
	Container string // mkv
}

func (n naming) folder(outDir string) string {
	switch n.Kind {
	case kindShow, kindMovie:
		base := n.NameDots
		if base == "" {
			base = dots(n.Title)
		}
		if n.Year > 0 {
			base = fmt.Sprintf("%s.%d", base, n.Year)
		}
		if n.TMDBID > 0 {
			base = fmt.Sprintf("%s {tmdb-%d}", base, n.TMDBID)
		}
		dir := filepath.Join(outDir, sanitizePath(base))
		if n.Kind == kindShow && n.Season > 0 {
			dir = filepath.Join(dir, fmt.Sprintf("Season %02d", n.Season))
		}
		return dir
	default:
		return filepath.Join(outDir, sanitizePath(n.Title))
	}
}

func (n naming) filename() string {
	parts := []string{}
	if n.Kind == kindShort {
		title := strings.TrimSpace(n.Title)
		if title == "" {
			title = "episode"
		}
		parts = append(parts, title)
		if n.Season > 0 || n.Episode > 0 {
			parts = append(parts, fmt.Sprintf("S%02dE%02d", max(n.Season, 1), max(n.Episode, 1)))
		}
	} else {
		name := n.NameDots
		if name == "" {
			name = dots(n.Title)
		}
		parts = append(parts, name)
		if n.Kind == kindShow {
			parts = append(parts, fmt.Sprintf("S%02dE%02d", max(n.Season, 1), max(n.Episode, 1)))
		}
		if n.Year > 0 {
			parts = append(parts, strconv.Itoa(n.Year))
		}
	}
	if n.Height > 0 {
		parts = append(parts, fmt.Sprintf("%dp", n.Height))
	}
	if n.Source != "" {
		parts = append(parts, n.Source)
	}
	parts = append(parts, "WEB-DL")
	if n.Codec != "" {
		parts = append(parts, n.Codec)
	}
	if n.DV {
		parts = append(parts, "DV")
	}
	if n.Audio != "" {
		parts = append(parts, n.Audio)
	}
	ext := n.Container
	if ext == "" {
		ext = "mkv"
	}
	stem := sanitizePath(strings.Join(parts, "."))
	g := strings.TrimSpace(n.Group)
	if g != "" {
		return stem + "-" + sanitizePath(g) + "." + ext
	}
	return stem + "." + ext
}

func sourceTag(provider string) string {
	switch provider {
	case "youku":
		return "YK"
	case "tencent":
		return "TX"
	case "hongguo":
		return "HG"
	case "douyin":
		return "DY"
	default:
		if provider == "" {
			return "WEB"
		}
		return strings.ToUpper(provider[:min(len(provider), 3)])
	}
}

func dots(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	lastDot := true
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastDot = false
			continue
		}
		if !lastDot {
			b.WriteByte('.')
			lastDot = true
		}
	}
	out := strings.Trim(b.String(), ".")
	if out == "" {
		return "Untitled"
	}
	return out
}

func sanitizePath(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			b.WriteByte('_')
		default:
			if r < 32 {
				continue
			}
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

var epRe = regexp.MustCompile(`(?i)(?:第\s*)(\d+)\s*集|E(\d+)|EP(\d+)`)

func guessEpisode(title string) int {
	m := epRe.FindStringSubmatch(title)
	if m == nil {
		return 0
	}
	for i := 1; i < len(m); i++ {
		if m[i] != "" {
			n, _ := strconv.Atoi(m[i])
			return n
		}
	}
	return 0
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
