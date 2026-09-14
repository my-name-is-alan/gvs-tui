package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func writeTvShowNFO(dir, title, plot string, tmdbID int) error {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<tvshow>\n")
	b.WriteString(xmlTag("title", title))
	if plot != "" {
		b.WriteString(xmlTag("plot", plot))
	}
	if tmdbID > 0 {
		b.WriteString(fmt.Sprintf("  <uniqueid type=\"tmdb\" default=\"true\">%d</uniqueid>\n", tmdbID))
	}
	b.WriteString("</tvshow>\n")
	return os.WriteFile(filepath.Join(dir, "tvshow.nfo"), []byte(b.String()), 0o644)
}

func writeEpisodeNFO(mediaPath, title string, season, ep int, plot string) error {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<episodedetails>\n")
	b.WriteString(xmlTag("title", title))
	if season > 0 {
		b.WriteString(xmlTag("season", fmt.Sprintf("%d", season)))
	}
	if ep > 0 {
		b.WriteString(xmlTag("episode", fmt.Sprintf("%d", ep)))
	}
	if plot != "" {
		b.WriteString(xmlTag("plot", plot))
	}
	b.WriteString("</episodedetails>\n")
	nfo := strings.TrimSuffix(mediaPath, filepath.Ext(mediaPath)) + ".nfo"
	return os.WriteFile(nfo, []byte(b.String()), 0o644)
}

func xmlTag(name, v string) string {
	v = strings.ReplaceAll(v, "&", "&amp;")
	v = strings.ReplaceAll(v, "<", "&lt;")
	v = strings.ReplaceAll(v, ">", "&gt;")
	return fmt.Sprintf("  <%s>%s</%s>\n", name, v, name)
}
