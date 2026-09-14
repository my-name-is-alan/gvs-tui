package main

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
)

func hostIsLocal(host string) bool {
	u, err := url.Parse(host)
	if err != nil {
		return false
	}
	h := u.Hostname()
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

type qrStart struct {
	Ticket string `json:"yk_ticket"`
	URL    string `json:"qrCodeUrl"`
	QRURL  string `json:"qr_url"`
}

func startYoukuQR(ctx context.Context, c *gwClient) (ticket, qrURL, ascii string, err error) {
	var data map[string]any
	if err := c.invoke(ctx, "youku", "login", map[string]any{"method": "qr", "force": "1"}, nil, &data); err != nil {
		return "", "", "", err
	}
	ticket, _ = data["yk_ticket"].(string)
	if ticket == "" {
		ticket, _ = data["ticket"].(string)
	}
	qrURL, _ = data["qrCodeUrl"].(string)
	if qrURL == "" {
		qrURL, _ = data["qr_url"].(string)
	}
	if qrURL == "" {
		qrURL, _ = data["url"].(string)
	}
	ascii = qrASCII(qrURL)
	return ticket, qrURL, ascii, nil
}

func pollYoukuQR(ctx context.Context, c *gwClient, ticket string) (sign string, pending bool, err error) {
	var data map[string]any
	if err := c.invoke(ctx, "youku", "login", map[string]any{"method": "qr", "state": "check", "yk_ticket": ticket}, nil, &data); err != nil {
		// 未扫/未确认时常是业务错误
		msg := err.Error()
		if strings.Contains(msg, "wait") || strings.Contains(msg, "WAIT") ||
			strings.Contains(msg, "扫") || strings.Contains(msg, "pending") ||
			strings.Contains(msg, "NEW") || strings.Contains(msg, "SCAN") {
			return "", true, nil
		}
		return "", true, nil
	}
	sign, _ = data["yk_sign"].(string)
	if sign == "" {
		sign, _ = data["sign"].(string)
	}
	if sign != "" {
		return sign, false, nil
	}
	st, _ := data["status"].(string)
	if st == "ok" || st == "SUCCESS" {
		return "", true, fmt.Errorf("已确认但没有 yk_sign")
	}
	return "", true, nil
}

func importYoukuCookie(ctx context.Context, c *gwClient, cookie string) (string, error) {
	var data map[string]any
	err := c.invoke(ctx, "youku", "login", map[string]any{"method": "cookie", "cookie": cookie}, nil, &data)
	if err != nil {
		return "", err
	}
	sign, _ := data["yk_sign"].(string)
	if sign == "" {
		sign, _ = data["sign"].(string)
	}
	if sign == "" {
		return "", fmt.Errorf("没有 yk_sign，Cookie 可能缺 P_sck")
	}
	return sign, nil
}

func qrASCII(raw string) string {
	if raw == "" {
		return "(无二维码 URL)"
	}
	q, err := qrcode.New(raw, qrcode.Medium)
	if err != nil {
		return raw
	}
	return q.ToSmallString(false)
}

func pollDelay() time.Duration { return 2 * time.Second }
