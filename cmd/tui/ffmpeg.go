package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func lookFFmpeg(bin string) string {
	if p := ffmpegExists(bin); p != "" {
		return p
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	if p, err := exec.LookPath("ffmpeg.exe"); err == nil {
		return p
	}
	cfg, _ := os.UserConfigDir()
	home, _ := os.UserHomeDir()
	local := os.Getenv("LOCALAPPDATA")
	pf := os.Getenv("ProgramFiles")
	cands := []string{
		filepath.Join(cfg, "gvs", "bin", "ffmpeg.exe"),
		filepath.Join(home, "scoop", "shims", "ffmpeg.exe"),
		`C:\ffmpeg\bin\ffmpeg.exe`,
		filepath.Join(pf, "ffmpeg", "bin", "ffmpeg.exe"),
		filepath.Join(pf, "Gyan", "FFmpeg", "ffmpeg.exe"),
		filepath.Join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
	}
	for _, c := range cands {
		if p := ffmpegExists(c); p != "" {
			return p
		}
	}
	globs := []string{
		filepath.Join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", "ffmpeg.exe"),
		filepath.Join(local, "Microsoft", "WinGet", "Packages", "*", "bin", "ffmpeg.exe"),
		filepath.Join(pf, "ffmpeg*", "bin", "ffmpeg.exe"),
	}
	for _, g := range globs {
		hits, _ := filepath.Glob(g)
		for _, h := range hits {
			if p := ffmpegExists(h); p != "" {
				return p
			}
		}
	}
	return ""
}

func ffmpegExists(p string) string {
	if p == "" || p == "ffmpeg" || p == "ffmpeg.exe" {
		return ""
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return ""
	}
	return p
}

func ffmpegDecryptCopy(ffmpeg, keyHex, inPath, outPath string) error {
	args := []string{"-hide_banner", "-loglevel", "error", "-y"}
	if keyHex != "" {
		args = append(args, "-decryption_key", strings.ToLower(strings.TrimSpace(keyHex)))
	}
	args = append(args, "-i", inPath, "-c", "copy", outPath)
	cmd := exec.Command(ffmpeg, args...)
	hideWin(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %v %s", err, truncate(string(out), 300))
	}
	return nil
}

func ffmpegRemux(ffmpeg, inPath, outPath string) error {
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", inPath, "-c", "copy", outPath)
	hideWin(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg remux: %v %s", err, truncate(string(out), 300))
	}
	return nil
}

func ffmpegConcat(ffmpeg, listFile, outPath string) error {
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
		"-fflags", "+genpts", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath)
	cmd.Dir = filepath.Dir(listFile)
	hideWin(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg concat: %v %s", err, truncate(string(out), 300))
	}
	return nil
}

func writeConcatList(paths []string, listPath string) error {
	var b strings.Builder
	dir := filepath.Dir(listPath)
	for _, p := range paths {
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			rel = filepath.Base(p)
		}
		rel = filepath.ToSlash(rel)
		rel = strings.ReplaceAll(rel, "'", `'\''`)
		b.WriteString("file '")
		b.WriteString(rel)
		b.WriteString("'\n")
	}
	return os.WriteFile(listPath, []byte(b.String()), 0o644)
}

func hideWin(cmd *exec.Cmd) {
	cmd.Stdin = nil
	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = windowsNoWindow()
	}
}
