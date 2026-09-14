package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type fileConfig struct {
	Host          string `json:"host"`
	Key           string `json:"key"`
	OutDir        string `json:"outDir"`
	ReleaseGroup  string `json:"releaseGroup"`
	TMDBKey       string `json:"tmdbKey"`
	TMDBLang      string `json:"tmdbLang"`
	YoukuSign     string `json:"youkuSign"`
	TencentCookie string `json:"tencentCookie"`
	HongguoMerge  bool   `json:"hongguoMerge"`
	HongguoNFO    bool   `json:"hongguoNfo"`
	HongguoFmt    string `json:"hongguoFmt"`
	FFmpeg        string `json:"ffmpeg"`
}

func defaultConfig() fileConfig {
	return fileConfig{
		Host:         "http://127.0.0.1:8080",
		OutDir:       filepath.Join(".", "downloads"),
		ReleaseGroup: "ADWeb",
		TMDBLang:     "zh-CN",
		HongguoMerge: true,
		HongguoNFO:   true,
		HongguoFmt:   "mkv",
		FFmpeg:       "ffmpeg",
	}
}

func configPath() string {
	if d, err := os.UserConfigDir(); err == nil && d != "" {
		return filepath.Join(d, "gvs", "tui.json")
	}
	return "tui.json"
}

func loadConfig() fileConfig {
	cfg := defaultConfig()
	b, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(b, &cfg)
	if cfg.Host == "" {
		cfg.Host = "http://127.0.0.1:8080"
	}
	cfg.Host = strings.TrimRight(cfg.Host, "/")
	if cfg.OutDir == "" {
		cfg.OutDir = filepath.Join(".", "downloads")
	}
	if cfg.ReleaseGroup == "" {
		cfg.ReleaseGroup = "ADWeb"
	}
	if cfg.HongguoFmt == "" {
		cfg.HongguoFmt = "mkv"
	}
	if cfg.FFmpeg == "" {
		cfg.FFmpeg = "ffmpeg"
	}
	if cfg.TMDBLang == "" {
		cfg.TMDBLang = "zh-CN"
	}
	return cfg
}

func saveConfig(cfg fileConfig) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}
