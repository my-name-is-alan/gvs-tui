package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type tmdbHit struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	Title        string `json:"title"`
	OriginalName string `json:"original_name"`
	OriginalTit  string `json:"original_title"`
	FirstAir     string `json:"first_air_date"`
	Release      string `json:"release_date"`
	Overview     string `json:"overview"`
	Media        string `json:"media_type"`
}

func (h tmdbHit) display() string {
	n := h.Name
	if n == "" {
		n = h.Title
	}
	y := h.year()
	if y > 0 {
		return fmt.Sprintf("%s (%d)  tmdb-%d", n, y, h.ID)
	}
	return fmt.Sprintf("%s  tmdb-%d", n, h.ID)
}

func (h tmdbHit) year() int {
	s := h.FirstAir
	if s == "" {
		s = h.Release
	}
	if len(s) >= 4 {
		y, _ := strconv.Atoi(s[:4])
		return y
	}
	return 0
}

func (h tmdbHit) englishDots() string {
	n := h.OriginalName
	if n == "" {
		n = h.OriginalTit
	}
	if n == "" {
		n = h.Name
	}
	if n == "" {
		n = h.Title
	}
	return dots(n)
}

func tmdbSearch(apiKey, lang, query string, tv bool) ([]tmdbHit, error) {
	if apiKey == "" || query == "" {
		return nil, fmt.Errorf("未配置 TMDB API Key")
	}
	kind := "movie"
	if tv {
		kind = "tv"
	}
	u := fmt.Sprintf("https://api.themoviedb.org/3/search/%s?api_key=%s&language=%s&query=%s",
		kind, url.QueryEscape(apiKey), url.QueryEscape(lang), url.QueryEscape(query))
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	cl := &http.Client{Timeout: 20 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("tmdb %s", resp.Status)
	}
	var out struct {
		Results []tmdbHit `json:"results"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	if len(out.Results) > 8 {
		out.Results = out.Results[:8]
	}
	return out.Results, nil
}
