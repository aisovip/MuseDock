# FireRed 本地转写

默认路线：FireRedASR2-AED INT8 识别中英文 → 同一原始权重的 CTC 分支强制对齐 AED token → 中文逐字／英文逐词时间戳。Silero VAD 仅做人声检测与分段；字幕起止来自声学对齐，不使用 VAD 边界或按字数估算。此服务不读取视频画面，也不调用分析模型或云端 ASR。

## 安装

安装 Python **3.11 或 3.12**（64 位），在项目根目录运行：

```sh
npm run setup:asr
# 指定基础解释器；只向新建的独立 venv 安装依赖
npm run setup:asr -- --python /path/to/python3.11
# 自定义缓存；设置页面也需要填写同一目录
npm run setup:asr -- --model-cache /path/to/firered-models
```

Windows 可用 `py -3.11`／`py -3.12` 自动查找；其他系统探测 `python3`／`python`。Linux 可能需要系统提供的 `python3.11-venv` 包。运行时只用 CPU，没有 PyTorch、CUDA 或 FunASR 依赖。安装按 requirements.txt 固定所有 Python 包版本。

首次模型下载约 1.36 GB，下载及解压缓存需至少 5 GB 空间；低内存机器可能无法加载。安装使用官方 release、固定文件大小和 SHA-256，并支持下载续传。网络失败时重新运行命令即可；不在 npm install 时自动下载模型。`--source-cache` 可以指定含原始 release 文件的离线目录，文件仍须通过同一哈希校验；不要把此目录写成项目默认配置。

环境和模型写入 MuseDock 数据目录下的 `data/runtime/firered` 与 `data/models/firered`。开发版默认使用项目根目录；桌面版使用 Electron userData。给桌面版安装时，先将 `MUSEDOCK_DATA_DIR` 指向该版本的数据目录，再用 Node 执行安装包 resources/app 中的 `scripts/setup-asr.cjs`；桌面版仍需外部 Python 与 Node，不随安装包分发环境或权重。

安装完成后，在全局 ASR 选择 **FireRed（本地，默认）**。默认地址 `http://127.0.0.1:8001/v1`，与旧 FunASR 的 8000 端口独立。修改本地服务设置后仍需点击页面上方“保存模型配置”。旧 `builtin/funasr` 选择会迁移，新模型不会继承旧 FunASR Python、ModelScope 缓存或服务地址；已有 `供应商/asr` 选择不迁移。

## 服务与结果

转写时自动检查本机服务并启动；必须先完成上述安装。也可手动运行：

```sh
# Windows 用 data/runtime/firered/Scripts/python.exe
data/runtime/firered/bin/python server/resources/firered/server.py --model-cache data/models/firered
```

支持 `--threads 1..32`，默认最多 6 线程。仅监听 loopback；远程部署需自行配置认证代理，并在供应商的 ASR 接口中选择 FireRed，不会自动启动远程服务。

- `GET /health`：识别模型、对齐来源、字词能力及运行版本。仅有 `/v1/models` 不足以通过自动启动健康检查。
- `POST /v1/audio/transcriptions`：OpenAI multipart 风格，模型 `fireredasr2-aed`，上传 16 kHz 单声道 WAV（上限 25 MiB）。MuseDock 自动用 FFmpeg 准备音频；大音频按真实音频偏移合并。
- `sentence_info` 起止单位毫秒，片内 `words` 及顶层 `words` 起止单位秒；MuseDock JSON 将字词统一为 `startMs/endMs` 并保留 confidence。
- `timing_source=firered_aed_ctc_forced_alignment`。声学帧约 40 ms，边界不是人工标注；低 confidence 应人工听音核对，不表示校订已确认正确。
- SRT 在完整字词边界按停顿、长度（通常至多 24 个字符）和时长（通常至多 6.5 秒）分段；保留原识别文字。每条字幕直接取首尾字词的声学起止，不按字数分配时间，也不切开英文词。原 HTTP 识别分组继续保留在 rawResponses 中。
- 有效空人声结果为 `no_speech_detected`，空文字及空字词，不合成虚构字幕。
- 识别文本与字词证据不一致、缺失、重叠、越界或对齐失败时停止交付；原始响应／媒体保留。

环境变量：`FIRERED_BASE_URL`、`FIRERED_PYTHON`、`FIRERED_MODEL_CACHE`、`FIRERED_AUTO_START=0`、`FIRERED_START_TIMEOUT_MS`。显式 `ASR_PROVIDER` 继续优先于内置默认；FunASR 的环境变量不用于 FireRed。单请求默认等待最多 20 分钟；慢机器可调整调用层超时。并发识别返回 429，避免重复加载模型占用内存。

## 性能与准确率边界

本机 Windows／i5-12490F／CPU 6 线程实测约 239 秒音频：独立 AED 识别约 174 秒，CTC 对齐约 31 秒；这不是其他机器的速度保证。失败样本的部分错词明显改善，仍有同音字／专名错误；没有全片人工参考转录，不能给出全片 CER/WER，也不代表对所有视频优于 Paraformer。无旁白、背景音乐或多人重叠等素材仍需分别评估。已验证 Windows CPU；Linux、macOS 和打包后的桌面安装尚未作端到端验收。

## 来源与许可

资产名、版本、大小、SHA-256 见 [models.json](./models.json)，下载自 [sherpa-onnx 官方 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)。模型与 Python 环境不纳入 MuseDock 仓库或安装包。

- FireRed 原始权重：[FireRedTeam/FireRedASR2-AED 模型卡](https://huggingface.co/FireRedTeam/FireRedASR2-AED/blob/main/README.md) 明确声明 Apache-2.0；[FireRedASR2S 源码](https://github.com/FireRedTeam/FireRedASR2S) 亦采用 Apache-2.0。
- sherpa 官方 [AED 导出说明](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/v2-aed.html) 与 [CTC 导出说明](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/v2-ctc.html) 确认二者来自上述 AED 权重；CTC 包只含 CTC 分支。
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/LICENSE) 与 [kaldi-native-fbank](https://github.com/csukuangfj/kaldi-native-fbank/blob/master/LICENSE)：Apache-2.0；[ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)：MIT。
- [Silero VAD](https://github.com/snakers4/silero-vad)：上游预训练模型 MIT；使用 k2-fsa 维护的 16 kHz ONNX 导出。

项目许可不替代第三方许可。实际再分发权重、二进制或改造后的导出时，请保留第三方许可证、版权告知、适用 NOTICE 与修改说明；分离下载不能免除再分发义务。下载器保留模型包的普通文件及说明（不解压测试音频）。
