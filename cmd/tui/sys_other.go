//go:build !windows

package main

import "syscall"

func windowsNoWindow() *syscall.SysProcAttr { return nil }
