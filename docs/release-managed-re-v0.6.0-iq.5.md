# GVS RE 0.6.0-gvs-iq.5

新增 CHACHA20_V3 自定义 HLS 解密方法。使用 32 字节 key 和 12 字节 nonce，实现腾讯原生 V3 的状态布局、轮函数和连续分片内字节流；每个 HLS 分片从偏移 0 开始。旧 CHACHA20 每 1024 字节重置的行为保持不变。

7 组原生 ARM 对照向量和 HLS Key Processor 回归通过，涵盖 64 位 counter 边界。真实首分片下载／解密成功，输出与 Python 参考逐字节一致；另一个实际分片 TS 同步也全部通过。

保留已有 IQ 功能。首段 HEVC 在 FFmpeg 下有 CABAC/cu_qp_delta 警告，不能将取钥、TS 同步或字节对照视为整集播放验收。
