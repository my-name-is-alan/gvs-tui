package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type jobEvt struct {
	ID     int
	Status string
	Pct    float64
	Log    string
	Err    string
	Done   bool
}

type jobHub struct {
	ch   chan tea.Msg
	work chan func()
}

func newHub() *jobHub {
	h := &jobHub{ch: make(chan tea.Msg, 1024), work: make(chan func(), 512)}
	for i := 0; i < 2; i++ {
		go func() {
			for fn := range h.work {
				fn()
			}
		}()
	}
	return h
}

func (h *jobHub) send(m tea.Msg) {
	e, ok := m.(jobEvt)
	dropOK := ok && !e.Done && e.Status != "失败" && e.Status != "完成"
	select {
	case h.ch <- m:
	default:
		if !dropOK {
			h.ch <- m
		}
	}
}

func (h *jobHub) wait() tea.Cmd {
	return func() tea.Msg { return <-h.ch }
}

func (h *jobHub) enqueue(id int, cfg fileConfig, c *gwClient, t dlTask) {
	h.work <- func() { runTask(h, id, cfg, c, t) }
}

var jobSeq int32

func nextJobID() int { return int(atomic.AddInt32(&jobSeq, 1)) }

type dlTask struct {
	Provider string
	Title    string
	Series   string
	VID      string
	Season   int
	Episode  int
	Height   int
	Quality  string
	Group    string
	Codec    string
	TMDBID   int
	NameDots string
	Year     int
	Plot     string
}

func runTask(h *jobHub, id int, cfg fileConfig, c *gwClient, t dlTask) {
	emit := func(st string, pct float64, log string) {
		h.send(jobEvt{ID: id, Status: st, Pct: pct, Log: log})
	}
	fail := func(err error) {
		h.send(jobEvt{ID: id, Status: "失败", Err: err.Error(), Done: true})
	}
	kind := kindShow
	src := sourceTag(t.Provider)
	cont := "mkv"
	if t.Provider == "hongguo" {
		kind = kindShort
		if cfg.HongguoFmt != "" {
			cont = cfg.HongguoFmt
		}
	}
	group := strings.TrimSpace(t.Group)
	if group == "" {
		group = cfg.ReleaseGroup
	}
	codec := t.Codec
	if codec == "" {
		codec = "H264"
	}
	n := naming{
		Kind: kind, Title: t.Series, NameDots: t.NameDots, Year: t.Year,
		Season: t.Season, Episode: t.Episode, Height: t.Height,
		Source: src, Group: group, TMDBID: t.TMDBID, Container: cont,
		Codec: codec,
	}
	if n.Title == "" {
		n.Title = t.Title
	}
	if kind == kindShort {
		n.Title = t.Series
		if n.Title == "" {
			n.Title = t.Title
		}
	}
	dir := n.folder(cfg.OutDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(err)
		return
	}
	out := filepath.Join(dir, n.filename())
	ffmpeg := lookFFmpeg(cfg.FFmpeg)
	if ffmpeg == "" {
		fail(fmt.Errorf("没有 ffmpeg。设置页填 ffmpeg.exe 完整路径，或安装后重开 TUI"))
		return
	}
	emit("取链", 0.01, filepath.Base(out))

	var err error
	switch t.Provider {
	case "hongguo":
		err = dlHongguo(c, cfg, t, dir, out, ffmpeg, emit)
	case "youku":
		err = dlYouku(c, cfg, t, dir, out, ffmpeg, emit)
	case "tencent":
		err = dlTencent(c, cfg, t, dir, out, ffmpeg, emit)
	case "douyin":
		err = dlDouyin(c, cfg, t, dir, out, ffmpeg, emit)
	default:
		err = fmt.Errorf("demo 尚未接 %s 下载管线", t.Provider)
	}
	if err != nil {
		fail(err)
		return
	}
	if t.Provider == "hongguo" && cfg.HongguoNFO {
		_ = writeTvShowNFO(dir, t.Series, t.Plot, 0)
		_ = writeEpisodeNFO(out, t.Title, t.Season, t.Episode, "")
	}
	if (t.Provider == "youku" || t.Provider == "tencent") && t.TMDBID > 0 {
		showDir := dir
		if t.Season > 0 {
			showDir = filepath.Dir(dir)
		}
		_ = writeTvShowNFO(showDir, t.Series, t.Plot, t.TMDBID)
		_ = writeEpisodeNFO(out, t.Title, t.Season, t.Episode, "")
	}
	h.send(jobEvt{ID: id, Status: "完成", Pct: 1, Log: out, Done: true})
}

func dlHongguo(c *gwClient, cfg fileConfig, t dlTask, dir, out, ffmpeg string, emit func(string, float64, string)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	emit("取链", 0.02, t.VID)
	var data map[string]any
	if err := c.invoke(ctx, "hongguo", "resolve", map[string]any{"vid": t.VID, "platform": "ios"}, nil, &data); err != nil {
		return err
	}
	cdn, spade, why := pickHongguo(data, t.VID, t.Quality)
	if cdn == "" {
		if why != "" {
			return fmt.Errorf("红果: %s", why)
		}
		return fmt.Errorf("红果没有 CDN  vid=%s", t.VID)
	}
	key := ""
	if spade != "" {
		emit("密钥", 0.05, "")
		var kd map[string]any
		if err := c.invoke(ctx, "hongguo", "key", map[string]any{"spade": spade}, nil, &kd); err == nil {
			key = asString(kd["key"])
			if key == "" {
				key = asString(kd["content_key_hex"])
			}
		}
	}
	enc := filepath.Join(dir, fmt.Sprintf(".%s.enc.mp4", t.VID))
	emit("下载", 0.08, "")
	if err := downloadProgress(cdn, enc, referer(t.Provider), speedCB(emit, "下载", 0.08, 0.7)); err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.mp4", t.VID))
	emit("解密", 0.82, "")
	if key != "" {
		if err := ffmpegDecryptCopy(ffmpeg, key, enc, tmp); err != nil {
			return err
		}
		_ = os.Remove(enc)
	} else {
		_ = os.Rename(enc, tmp)
	}
	emit("封装", 0.92, out)
	if err := ffmpegRemux(ffmpeg, tmp, out); err != nil {
		_ = os.Rename(tmp, strings.TrimSuffix(out, filepath.Ext(out))+".mp4")
		return err
	}
	_ = os.Remove(tmp)
	return nil
}

func dlTencent(c *gwClient, cfg fileConfig, t dlTask, dir, out, ffmpeg string, emit func(string, float64, string)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	emit("取链", 0.05, t.VID)

	defn := t.Quality
	if defn == "" {
		defn = "fhd"
	}
	var data map[string]any
	if err := c.invoke(ctx, "tencent", "play", map[string]any{"vid": t.VID, "defn": defn}, c.headers(cfg, "tencent"), &data); err != nil {
		return err
	}
	cdn := pickURL(data)
	if cdn == "" {
		return fmt.Errorf("腾讯没有 video.url")
	}
	if strings.Contains(strings.ToLower(cdn), ".m3u8") {
		return fmt.Errorf("HLS 下一期；当前片源是 m3u8")
	}
	raw := filepath.Join(dir, fmt.Sprintf(".%s.bin", t.VID))
	emit("下载", 0.1, "")
	if err := downloadProgress(cdn, raw, referer("tencent"), speedCB(emit, "下载", 0.1, 0.75)); err != nil {
		return err
	}

	emit("封装", 0.9, out)
	if err := ffmpegRemux(ffmpeg, raw, out); err != nil {
		return err
	}
	_ = os.Remove(raw)
	return nil
}

func dlDouyin(c *gwClient, _ fileConfig, t dlTask, _, out, _ string, emit func(string, float64, string)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	emit("取链", 0.02, t.VID)
	var data map[string]any
	if err := c.invoke(ctx, "douyin", "resolve", map[string]any{"url": "https://www.douyin.com/video/" + t.VID}, nil, &data); err != nil {
		return err
	}
	cdn := pickDouyinURL(data)
	if cdn == "" {
		return fmt.Errorf("抖音没有直链")
	}
	emit("下载", 0.1, cdn)
	return downloadProgress(cdn, out, referer("douyin"), speedCB(emit, "下载", 0.1, 0.85))
}

func pickDouyinURL(data map[string]any) string {
	media, _ := data["media"].([]any)
	fallback := ""
	for _, it := range media {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		u := asString(m["url"])
		if u == "" {
			continue
		}
		if asString(m["type"]) == "video" {
			return u
		}
		if fallback == "" {
			fallback = u
		}
	}
	return fallback
}

func dlYouku(c *gwClient, cfg fileConfig, t dlTask, dir, out, ffmpeg string, emit func(string, float64, string)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	emit("取链", 0.04, t.VID)
	input := map[string]any{"vid": t.VID, "expand": "1"}
	if t.Quality != "" {
		input["tier"] = "multi"
	} else {
		input["tier"] = "single"
	}
	var data map[string]any
	if err := c.invoke(ctx, "youku", "play", input, c.headers(cfg, "youku"), &data); err != nil {
		return err
	}
	key := ""
	if drm, ok := data["drm"].(map[string]any); ok {
		key = asString(drm["content_key_hex"])
	}
	urls := youkuStreamURLs(data, t.Quality)
	if len(urls) == 0 {
		return fmt.Errorf("优酷 play 没有分片")
	}

	raw := filepath.Join(dir, fmt.Sprintf(".%s.fmp4", t.VID))
	f, err := os.Create(raw)
	if err != nil {
		return err
	}
	for i, u := range urls {
		emit("下载", 0.05+0.7*float64(i)/float64(len(urls)), fmt.Sprintf("%d/%d", i+1, len(urls)))
		if err := appendURL(f, u, referer("youku")); err != nil {
			f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.mp4", t.VID))
	emit("解密", 0.8, "")
	if key != "" {
		if err := ffmpegDecryptCopy(ffmpeg, key, raw, tmp); err != nil {
			emit("解密", 0.8, "ffmpeg 解密失败，尝试直接封装")
			tmp = raw
		} else {
			_ = os.Remove(raw)
		}
	} else {
		tmp = raw
	}
	emit("封装", 0.92, out)
	if err := ffmpegRemux(ffmpeg, tmp, out); err != nil {
		return err
	}
	if tmp != raw {
		_ = os.Remove(tmp)
	} else {
		_ = os.Remove(raw)
	}
	return nil
}

func hongguoItem(data map[string]any, vid string) map[string]any {
	if videos, ok := data["videos"].(map[string]any); ok {
		if m, ok := videos[vid].(map[string]any); ok {
			return m
		}
		for _, v := range videos {
			if m, ok := v.(map[string]any); ok {
				return m
			}
		}
	}
	if m, ok := data["video"].(map[string]any); ok {
		return m
	}
	return data
}

func pickHongguo(data map[string]any, vid, want string) (cdn, spade, why string) {
	item := hongguoItem(data, vid)
	if item == nil {
		return "", "", "empty"
	}
	why = asString(item["err"])
	spade = asString(item["template"])
	if spade == "" {
		spade = asString(item["spade"])
	}
	want = strings.ToLower(strings.TrimSpace(want))
	rank := map[string]int{"1080p": 0, "720p": 1, "540p": 2, "480p": 3, "360p": 4}
	best := 99
	if streams, ok := item["streams"].([]any); ok {
		for _, s := range streams {
			m, _ := s.(map[string]any)
			u := asString(m["url"])
			q := strings.ToLower(asString(m["quality"]))
			if u == "" {
				continue
			}
			if want != "" && q == want {
				return u, spade, why
			}
			r, ok := rank[q]
			if !ok {
				r = 8
			}
			if r < best {
				best = r
				cdn = u
			}
		}
	}
	if cdn == "" {
		cdn = asString(item["url"])
	}
	return cdn, spade, why
}

func pickURL(data map[string]any) string {
	if v, ok := data["video"].(map[string]any); ok {
		if s := asString(v["url"]); s != "" {
			return s
		}
		if s := asString(v["playlist_url"]); s != "" {
			return s
		}
	}
	return asString(data["url"])
}

func speedCB(emit func(string, float64, string), status string, base, span float64) func(int64, int64) {
	start := time.Now()
	var last time.Time
	return func(n, total int64) {
		now := time.Now()
		if !last.IsZero() && now.Sub(last) < 250*time.Millisecond && (total <= 0 || n < total) {
			return
		}
		last = now
		p := base
		if total > 0 {
			p = base + span*float64(n)/float64(total)
		}
		sec := now.Sub(start).Seconds()
		spd := int64(0)
		if sec > 0.2 {
			spd = int64(float64(n) / sec)
		}
		tot := "?"
		if total > 0 {
			tot = human(total)
		}
		emit(status, p, fmt.Sprintf("%s/%s  %s/s", human(n), tot, human(spd)))
	}
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	var s string
	switch t := v.(type) {
	case string:
		s = t
	case json.Number:
		s = t.String()
	default:
		s = fmt.Sprint(v)
	}
	if s == "<nil>" || s == "null" {
		return ""
	}
	return s
}

func referer(p string) string {
	switch p {
	case "tencent":
		return "https://v.qq.com/"
	case "youku":
		return "https://www.youku.com/"
	case "douyin":
		return "https://www.douyin.com/"
	default:
		return ""
	}
}

func downloadProgress(src, dest, referer string, cb func(n, total int64)) error {
	req, err := http.NewRequest(http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("cdn %s", resp.Status)
	}
	total := resp.ContentLength
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, 64<<10)
	var n int64
	for {
		k, err := resp.Body.Read(buf)
		if k > 0 {
			if _, werr := f.Write(buf[:k]); werr != nil {
				return werr
			}
			n += int64(k)
			if cb != nil {
				cb(n, total)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func appendURL(w io.Writer, src, referer string) error {
	req, err := http.NewRequest(http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("cdn %s", resp.Status)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}
