//go:build windows

package main

import "syscall"

func windowsNoWindow() *syscall.SysProcAttr {
	const createNoWindow = 0x08000000
	return &syscall.SysProcAttr{CreationFlags: createNoWindow}
}
