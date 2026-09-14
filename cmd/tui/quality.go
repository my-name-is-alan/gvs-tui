package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type qChoice struct {
	Label  string
	ID     string
	Title  string
	Width  int
	Height int
	Size   int64
	Codec  string
	DRM    string
}

type qualityMsg struct {
	list []qChoice
	err  error
}

func probeQualities(ctx context.Context, c *gwClient, cfg fileConfig, provider, vid string) ([]qChoice, error) {
	switch provider {
	case "hongguo":
		return probeHongguo(ctx, c, vid)
	case "youku":
		return probeYouku(ctx, c, cfg, vid)
	case "tencent":
		return []qChoice{
			{Label: "蓝光 fhd", ID: "fhd", Title: "蓝光", Width: 1920, Height: 1080, Codec: "H265"},
			{Label: "超清 shd", ID: "shd", Title: "超清", Width: 1280, Height: 720, Codec: "H265"},
			{Label: "高清 hd", ID: "hd", Title: "高清", Width: 848, Height: 480, Codec: "H264"},
			{Label: "标清 sd", ID: "sd", Title: "标清", Width: 640, Height: 360, Codec: "H264"},
		}, nil
	case "douyin":
		return probeDouyin(ctx, c, vid)
	default:
		return nil, fmt.Errorf("这个平台还没接画质列表")
	}
}

func probeHongguo(ctx context.Context, c *gwClient, vid string) ([]qChoice, error) {
	var data map[string]any
	if err := c.invoke(ctx, "hongguo", "resolve", map[string]any{"vid": vid, "platform": "ios"}, nil, &data); err != nil {
		return nil, err
	}
	item := hongguoItem(data, vid)
	if item == nil {
		return nil, fmt.Errorf("红果没有 streams")
	}
	if why := asString(item["err"]); why != "" {
		return nil, fmt.Errorf("%s", why)
	}
	var out []qChoice
	streams, _ := item["streams"].([]any)
	for _, s := range streams {
		m, _ := s.(map[string]any)
		id := asString(m["quality"])
		u := asString(m["url"])
		if id == "" || u == "" {
			continue
		}
		h := heightOf(id)
		out = append(out, qChoice{
			Label:  strings.ToUpper(id),
			ID:     id,
			Title:  strings.ToUpper(id),
			Height: h,
			Codec:  "H265",
			DRM:    "CENC",
		})

	}
	if len(out) == 0 {
		return nil, fmt.Errorf("红果没有可用画质")
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Height > out[j].Height })
	return out, nil
}

func probeDouyin(ctx context.Context, c *gwClient, vid string) ([]qChoice, error) {
	var data map[string]any
	if err := c.invoke(ctx, "douyin", "resolve", map[string]any{"url": "https://www.douyin.com/video/" + vid}, nil, &data); err != nil {
		return nil, err
	}
	media, _ := data["media"].([]any)
	var out []qChoice
	for i, it := range media {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		u := asString(m["url"])
		if u == "" {
			continue
		}
		typ := asString(m["type"])
		if typ == "" {
			typ = "video"
		}
		w, h := anyInt(m["width"]), anyInt(m["height"])
		label := typ
		if h > 0 {
			label = fmt.Sprintf("%s %dp", typ, h)
		}
		id := typ
		if i > 0 {
			id = fmt.Sprintf("%s-%d", typ, i)
		}
		out = append(out, qChoice{
			Label:  label,
			ID:     id,
			Title:  asString(data["content"]),
			Width:  w,
			Height: h,
			Codec:  "H264",
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("抖音没有媒体")
	}
	return out, nil
}

func probeYouku(ctx context.Context, c *gwClient, cfg fileConfig, vid string) ([]qChoice, error) {
	var data map[string]any
	if err := c.invoke(ctx, "youku", "play", map[string]any{"vid": vid, "tier": "multi", "expand": "0"}, c.headers(cfg, "youku"), &data); err != nil {
		return nil, err
	}
	arr, _ := data["streams"].([]any)
	seen := map[string]bool{}
	var out []qChoice
	for _, s := range arr {
		m, _ := s.(map[string]any)
		mt := strings.ToLower(asString(m["media_type"]))
		if mt == "audio" || mt == "subtitle" {
			continue
		}
		id := asString(m["stream_type"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		h := anyInt(m["height"])
		w := anyInt(m["width"])
		sz := anyInt64(m["size"])
		codec := "H264"
		if asBool(m["h265"]) {
			codec = "H265"
		}
		drm := asString(m["drm"])
		res := id
		if h > 0 && w > 0 {
			res = fmt.Sprintf("%dx%d", w, h)
		} else if h > 0 {
			res = fmt.Sprintf("%dp", h)
		}
		label := res
		if sz > 0 {
			label += "  " + human(sz)
		}
		label += "  " + codec
		out = append(out, qChoice{
			Label:  label,
			ID:     id,
			Title:  id,
			Width:  w,
			Height: h,
			Size:   sz,
			Codec:  codec,
			DRM:    drm,
		})

	}
	if len(out) == 0 {
		if v, ok := data["video"].(map[string]any); ok {
			h := anyInt(v["height"])
			id := asString(v["stream_type"])
			if id == "" {
				id = "default"
			}
			label := id
			if h > 0 {
				label = fmt.Sprintf("%dp  %s", h, id)
			}
			out = append(out, qChoice{Label: label, ID: id, Height: h})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("优酷没有画质列表")
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Height > out[j].Height })
	return out, nil
}

func heightOf(q string) int {
	q = strings.ToLower(strings.TrimSpace(q))
	q = strings.TrimSuffix(q, "p")
	n, _ := strconv.Atoi(q)
	return n
}

func anyInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case jsonNumber:
		n, _ := strconv.Atoi(string(t))
		return n
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

func anyInt64(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	}
	return int64(anyInt(v))
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "1" || strings.EqualFold(t, "true")
	}
	return false
}

// jsonNumber avoids importing encoding/json just for Number in this file.
type jsonNumber string

func youkuStreamURLs(data map[string]any, want string) []string {
	if want != "" {
		if arr, ok := data["streams"].([]any); ok {
			for _, s := range arr {
				m, _ := s.(map[string]any)
				if asString(m["stream_type"]) != want {
					continue
				}
				if u := asString(m["playlist_url"]); u != "" {
					initU, segs, err := parseCMAF(u, referer("youku"))
					if err == nil {
						out := []string{}
						if initU != "" {
							out = append(out, initU)
						}
						return append(out, segs...)
					}
					return []string{u}
				}
			}
		}
	}
	var urls []string
	if v, ok := data["video"].(map[string]any); ok {
		if init := asString(v["init_url"]); init != "" {
			urls = append(urls, init)
		}
		if arr, ok := v["segment_urls"].([]any); ok {
			for _, x := range arr {
				if s, ok := x.(string); ok && s != "" {
					urls = append(urls, s)
				}
			}
		}
		if len(urls) == 0 {
			if u := asString(v["playlist_url"]); u != "" {
				urls = append(urls, u)
			}
			if u := asString(v["url"]); u != "" && len(urls) == 0 {
				urls = append(urls, u)
			}
		}
	}
	return urls
}

func parseCMAF(playlistURL, ref string) (initURL string, segs []string, err error) {
	req, err := http.NewRequest(http.MethodGet, playlistURL, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if ref != "" {
		req.Header.Set("Referer", ref)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", nil, err
	}
	base := playlistURL
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[:i+1]
	}
	abs := func(u string) string {
		if strings.HasPrefix(u, "http") {
			return u
		}
		return base + u
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#EXT-X-MAP:") {
			if i := strings.Index(line, "URI=\""); i >= 0 {
				rest := line[i+5:]
				if j := strings.Index(rest, `"`); j >= 0 {
					initURL = abs(rest[:j])
				}
			}
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		segs = append(segs, abs(line))
	}
	return initURL, segs, nil
}
