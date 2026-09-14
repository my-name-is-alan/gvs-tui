package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type envelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

type keyInfo struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Prefix    string   `json:"prefix"`
	Scope     []string `json:"scope"`
	All       bool     `json:"all"`
	QPS       int      `json:"qps"`
	Daily     int64    `json:"daily"`
	UsedToday int64    `json:"usedToday"`
	ExpiresAt *string  `json:"expiresAt"`
	Permanent bool     `json:"permanent"`
	DaysLeft  *int     `json:"daysLeft"`
}

type gwClient struct {
	host string
	key  string
	http *http.Client
}

func newClient(host, key string) *gwClient {
	return &gwClient{
		host: strings.TrimRight(host, "/"),
		key:  key,
		http: &http.Client{Timeout: 45 * time.Second},
	}
}

func (c *gwClient) allows(scope []string, all bool, name string) bool {
	if all || len(scope) == 0 {
		return true
	}
	for _, s := range scope {
		if s == name {
			return true
		}
	}
	return false
}

func (c *gwClient) do(ctx context.Context, method, path string, query url.Values, body any, extra http.Header) (*envelope, error) {
	u := c.host + path
	if query != nil {
		u += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, vs := range extra {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(b), 180))
	}
	if env.Code != 0 {
		return &env, fmt.Errorf("%s", env.Msg)
	}
	return &env, nil
}

func (c *gwClient) getJSON(ctx context.Context, path string, q url.Values, extra http.Header, dest any) error {
	env, err := c.do(ctx, http.MethodGet, path, q, nil, extra)
	if err != nil {
		return err
	}
	if dest == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	return json.Unmarshal(env.Data, dest)
}

func (c *gwClient) doJSON(ctx context.Context, method, path string, q url.Values, body any, extra http.Header, dest any) error {
	env, err := c.do(ctx, method, path, q, body, extra)
	if err != nil {
		return err
	}
	if dest == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	return json.Unmarshal(env.Data, dest)
}

// invoke is the canonical provider API used by the local downloader. The
// legacy provider-specific paths remain available on the server only for
// migration and diagnostics.
func (c *gwClient) invoke(ctx context.Context, providerName, action string, input map[string]any, extra http.Header, dest any) error {
	return c.doJSON(ctx, http.MethodPost, "/v1/invoke", nil, map[string]any{
		"provider": providerName,
		"action":   action,
		"input":    input,
	}, extra, dest)
}

func (c *gwClient) keyInfo(ctx context.Context) (*keyInfo, error) {
	var k keyInfo
	if err := c.getJSON(ctx, "/v1/key", nil, nil, &k); err != nil {
		return nil, err
	}
	return &k, nil
}

func (c *gwClient) headers(cfg fileConfig, provider string) http.Header {
	h := http.Header{}
	if provider == "youku" && cfg.YoukuSign != "" {
		h.Set("Yk-Sign", cfg.YoukuSign)
	}
	if provider == "tencent" && cfg.TencentCookie != "" {
		h.Set("Tx-Cookie", cfg.TencentCookie)
	}
	return h
}
