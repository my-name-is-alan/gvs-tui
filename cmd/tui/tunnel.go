package main

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type tunFrame struct {
	T      string              `json:"t"`
	ID     string              `json:"id,omitempty"`
	Method string              `json:"method,omitempty"`
	URL    string              `json:"url,omitempty"`
	Header map[string][]string `json:"header,omitempty"`
	Status int                 `json:"status,omitempty"`
	Body   string              `json:"body,omitempty"`
	Err    string              `json:"err,omitempty"`
}

type tunnelMsg struct {
	OK  bool
	Err string
}

func runTunnel(host, key string, onStatus func(tunnelMsg)) {
	for {
		err := tunnelOnce(host, key, onStatus)
		if onStatus != nil {
			onStatus(tunnelMsg{OK: false, Err: err.Error()})
		}
		time.Sleep(3 * time.Second)
	}
}

func tunnelOnce(host, key string, onStatus func(tunnelMsg)) error {
	u, err := url.Parse(host)
	if err != nil {
		return err
	}
	addr := u.Host
	if u.Port() == "" {
		if u.Scheme == "https" {
			addr += ":443"
		} else {
			addr += ":80"
		}
	}
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		tc := tls.Client(conn, &tls.Config{ServerName: u.Hostname()})
		if err := tc.Handshake(); err != nil {
			_ = conn.Close()
			return err
		}
		conn = tc
	}
	req := fmt.Sprintf("GET /v1/tunnel HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nUpgrade: tunnel\r\nConnection: Upgrade\r\n\r\n", u.Host, key)
	if _, err := io.WriteString(conn, req); err != nil {
		_ = conn.Close()
		return err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		_ = conn.Close()
		return err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return fmt.Errorf("tunnel http %s", resp.Status)
	}
	if onStatus != nil {
		onStatus(tunnelMsg{OK: true})
	}
	cl := &http.Client{Timeout: 40 * time.Second}
	w := bufio.NewWriter(conn)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			_ = conn.Close()
			return err
		}
		var f tunFrame
		if err := json.Unmarshal(line, &f); err != nil {
			continue
		}
		if f.T == "ping" {
			_, _ = w.WriteString(`{"t":"pong"}` + "\n")
			_ = w.Flush()
			continue
		}
		if f.T != "req" {
			continue
		}
		out := doLocal(cl, f)
		b, _ := json.Marshal(out)
		if _, err := w.Write(append(b, '\n')); err != nil {
			_ = conn.Close()
			return err
		}
		if err := w.Flush(); err != nil {
			_ = conn.Close()
			return err
		}
	}
}

func doLocal(cl *http.Client, f tunFrame) tunFrame {
	raw, _ := base64.StdEncoding.DecodeString(f.Body)
	req, err := http.NewRequest(f.Method, f.URL, strings.NewReader(string(raw)))
	if err != nil {
		return tunFrame{T: "res", ID: f.ID, Err: err.Error()}
	}
	req.Header = f.Header
	resp, err := cl.Do(req)
	if err != nil {
		return tunFrame{T: "res", ID: f.ID, Err: err.Error()}
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 6<<20))
	if err != nil {
		return tunFrame{T: "res", ID: f.ID, Err: err.Error()}
	}
	return tunFrame{
		T:      "res",
		ID:     f.ID,
		Status: resp.StatusCode,
		Header: resp.Header,
		Body:   base64.StdEncoding.EncodeToString(b),
	}
}
