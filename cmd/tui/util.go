package main

import "fmt"

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func human(n int64) string {
	const k = 1024.0
	fn := float64(n)
	switch {
	case fn >= k*k*k:
		return fmt.Sprintf("%.1f GB", fn/(k*k*k))
	case fn >= k*k:
		return fmt.Sprintf("%.1f MB", fn/(k*k))
	case fn >= k:
		return fmt.Sprintf("%.1f KB", fn/k)
	default:
		return fmt.Sprintf("%d B", n)
	}
}
