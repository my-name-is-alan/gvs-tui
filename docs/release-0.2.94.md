# TUI v0.2.94

配套网关 v3.9.129，支持从腾讯 SSE 返回的 CHACHA20_V3 参数传递给维护版 RE，并校验 V3 密钥和 nonce 长度。下载组件指向 managed-re-v0.6.0-iq.5，旧 CHACHA20 保留原有分块处理。

腾讯客户端定向测试、TypeScript 检查通过；实际首分片维护版 RE 退出成功且明文与 Python 参考相同。首段 HEVC 解码仍有警告，未完成整集验收。
